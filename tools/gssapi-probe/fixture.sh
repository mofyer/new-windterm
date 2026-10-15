#!/bin/bash
# Runs only in our disposable image; no host mount, network or credentials needed.
set -euo pipefail
trap 'printf "P0_GSSAPI_FIXTURE_ERROR line=%s exit=%s\n" "$LINENO" "$?" >&2' ERR
umask 077
test -f /p0-gssapi-disposable-image
test "$(id -u)" = 0
test "$(uname -s)" = Linux
install -d -o p0gss -g p0gss -m 700 /fixture/home
root=$(mktemp -d /fixture/run.XXXXXX)
kdc_pid=
sshd_pid=
cleanup() {
  for pid in "$sshd_pid" "$kdc_pid"; do
    if [ -n "$pid" ]; then kill "$pid" 2>/dev/null || true; fi
  done
  for pid in "$sshd_pid" "$kdc_pid"; do
    if [ -n "$pid" ]; then
      for ((i=0; i<40; i++)); do
        if ! kill -0 "$pid" 2>/dev/null; then break; fi
        sleep 0.05
      done
      kill -KILL "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
  done
  rm -rf "$root"
}
trap cleanup EXIT
trap 'exit 124' TERM INT
export HOME="$root" KRB5_CONFIG="$root/krb5.conf" KRB5_KDC_PROFILE="$root/kdc.conf"
export KRB5_KTNAME="FILE:$root/host.keytab" KRB5_CLIENT_KTNAME="FILE:$root/no-client.keytab"
export KRB5CCNAME="FILE:$root/valid.ccache"
unset KRB5_TRACE SSH_AUTH_SOCK
cat > "$KRB5_CONFIG" <<EOF
[libdefaults]
 default_realm = P0.TEST
 dns_lookup_kdc = false
 dns_lookup_realm = false
 dns_canonicalize_hostname = false
 # Disabling DNS does not disable MIT short-name qualification. Ignore the
 # container resolver's inherited search suffix when targeting host/localhost.
 qualify_shortname = ""
 rdns = false
 forwardable = false
 udp_preference_limit = 1
 clockskew = 2
[realms]
 P0.TEST = {
  kdc = 127.0.0.1:61088
 }
[domain_realm]
 localhost = P0.TEST
 .invalid = P0.TEST
EOF
cat > "$KRB5_KDC_PROFILE" <<EOF
[kdcdefaults]
 kdc_listen = 127.0.0.1:61088
 kdc_tcp_listen = 127.0.0.1:61088
[realms]
 P0.TEST = {
  database_name = $root/principal
  key_stash_file = $root/stash
  acl_file = $root/kadm5.acl
  max_life = 1h
  max_renewable_life = 0
 }
EOF
# The temporary database's master password is fixture-only and never reused.
timeout 15 kdb5_util create -s -P disposable-fixture-only -r P0.TEST > "$root/setup.log" 2>&1
for principal in p0gss host/localhost; do
  timeout 10 kadmin.local -q "addprinc -randkey $principal" >> "$root/setup.log" 2>&1
done
timeout 10 kadmin.local -q "ktadd -k $root/user.keytab p0gss" >> "$root/setup.log" 2>&1
timeout 10 kadmin.local -q "ktadd -k $root/host.keytab host/localhost" >> "$root/setup.log" 2>&1
krb5kdc -n -r P0.TEST -P "$root/kdc.pid" > "$root/kdc.log" 2>&1 &
kdc_pid=$!
wait_port() {
  local port=$1 pid=$2
  for ((i=0; i<100; i++)); do
    kill -0 "$pid"
    if (echo > "/dev/tcp/127.0.0.1/$port") 2>/dev/null; then return 0; fi
    sleep 0.05
  done
  return 1
}
wait_port 61088 "$kdc_pid"
timeout 10 kinit -k -t "$root/user.keytab" -l 5m p0gss@P0.TEST
timeout 10 klist -s
# Verify MIT host-based name construction before SSH, without pre-populating
# the Rust client's cache with a service ticket. Keep tool output private.
cp "$root/valid.ccache" "$root/preflight.ccache"
LC_ALL=C KRB5CCNAME="FILE:$root/preflight.ccache" \
  timeout 10 kvno -S host localhost > "$root/service-preflight.log" 2>&1
grep -Eq '^host/localhost@P0[.]TEST: kvno = [0-9]+$' "$root/service-preflight.log"
rm -f "$root/preflight.ccache"
printf 'P0_GSSAPI_SERVICE_PREFLIGHT PASS\n'
timeout 10 ssh-keygen -q -t ed25519 -N '' -f "$root/host"
export P0_GSSAPI_FINGERPRINT
P0_GSSAPI_FINGERPRINT=$(ssh-keygen -lf "$root/host.pub" -E sha256 | awk '{print $2}')
# A fixed forced command proves authentication reached the remote session. The
# file is owned by the disposable container user, never a runner host account.
cat > /fixture/home/proof.sh <<'EOF'
#!/bin/sh
set -eu
test "${SSH_ORIGINAL_COMMAND-}" = p0-gssapi-proof
printf 'executed\n' >> /fixture/home/executions
printf 'P0_GSSAPI_REMOTE_OK\n'
EOF
chmod 755 /fixture/home/proof.sh
cat > "$root/sshd_config" <<EOF
AddressFamily inet
ListenAddress 127.0.0.1
Port 61222
HostKey $root/host
PidFile $root/sshd.pid
AllowUsers p0gss@127.0.0.1
AuthenticationMethods gssapi-with-mic
GSSAPIAuthentication yes
GSSAPIStrictAcceptorCheck no
GSSAPICleanupCredentials yes
PubkeyAuthentication no
PasswordAuthentication no
KbdInteractiveAuthentication no
HostbasedAuthentication no
PermitEmptyPasswords no
UsePAM no
PermitRootLogin no
PermitUserEnvironment no
PermitUserRC no
PermitTTY no
DisableForwarding yes
X11Forwarding no
UseDNS no
LoginGraceTime 10
MaxAuthTries 1
MaxSessions 1
LogLevel VERBOSE
ForceCommand /bin/sh /fixture/home/proof.sh
EOF
timeout 10 /usr/sbin/sshd -t -f "$root/sshd_config"
/usr/sbin/sshd -D -e -f "$root/sshd_config" > "$root/sshd.log" 2>&1 &
sshd_pid=$!
wait_port 61222 "$sshd_pid"
export P0_GSSAPI_ISOLATED=1 P0_GSSAPI_PORT=61222 P0_GSSAPI_SERVICE=host@localhost
execution_count=0
run_case() {
  local name=$1 expected=$2 code=0
  # timeout is outside Rust too: native GSS calls may block the runtime thread.
  timeout --kill-after=2 30 p0-gssapi-probe > "$root/$name.log" 2>&1 || code=$?
  if [ "$code" != "$expected" ]; then
    printf 'P0_GSSAPI_CASE %s FAIL expected=%s actual=%s\n' "$name" "$expected" "$code"
    cat "$root/$name.log" # Probe logs contain statuses only, never credentials.
    return 1
  fi
  if [ "$expected" = 0 ]; then
    grep -qx P0_GSSAPI_ACCEPTED "$root/$name.log"
    execution_count=$((execution_count + 1))
  else
    grep -qx P0_GSSAPI_REJECTED "$root/$name.log"
  fi
  test "$(wc -l < /fixture/home/executions)" -eq "$execution_count"
  printf 'P0_GSSAPI_CASE %s PASS exit=%s remote_executions=%s\n' "$name" "$code" "$execution_count"
}
healthcheck() {
  # A dead/broken KDC must not make credential-negative cases appear to pass.
  # Acquire a fresh TGT and service ticket each time: reusing a cached service
  # ticket would let authentication succeed even if the KDC had died.
  rm -f "$root/health.ccache"
  KRB5CCNAME="FILE:$root/health.ccache" \
    timeout 10 kinit -k -t "$root/user.keytab" -l 5m p0gss@P0.TEST
  KRB5CCNAME="FILE:$root/health.ccache" P0_GSSAPI_SERVICE=host@localhost \
    timeout --kill-after=2 30 p0-gssapi-probe > "$root/health.log" 2>&1
  grep -qx P0_GSSAPI_ACCEPTED "$root/health.log"
  execution_count=$((execution_count + 1))
  test "$(wc -l < /fixture/home/executions)" -eq "$execution_count"
  printf 'P0_GSSAPI_HEALTH PASS remote_executions=%s\n' "$execution_count"
}
run_case valid 0
export KRB5CCNAME="FILE:$root/missing.ccache"
test ! -e "$root/missing.ccache"
run_case missing 10
healthcheck
export KRB5CCNAME="FILE:$root/expired.ccache"
timeout 10 kinit -k -t "$root/user.keytab" -l 1s p0gss@P0.TEST
test -s "$root/expired.ccache"
sleep 5
expired_status=0
timeout 10 klist -s || expired_status=$?
test "$expired_status" -eq 1
run_case expired 10
healthcheck
export KRB5CCNAME="FILE:$root/valid.ccache" P0_GSSAPI_SERVICE=host@missing.invalid
timeout 10 klist -s
run_case wrong-service 10
healthcheck
printf 'P0_GSSAPI_RESULT 4 passed; 0 skipped\n'
dpkg-query -W -f='${Package} ${Version}\n' krb5-kdc krb5-admin-server krb5-user openssh-server libgssapi-krb5-2
