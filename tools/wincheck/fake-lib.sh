#!/bin/sh
# Type-check only: create the requested archive as an empty file.
for a in "$@"; do case "$a" in -out:*|-OUT:*|/out:*|/OUT:*) : > "${a#*:}";; esac; done
exit 0
