#!/bin/sh
# Type-check only. Pretends to be llvm-rc (accepting -no-preprocess) and
# creates the requested /fo output as an empty file.
case " $* " in *" /? "*) echo "OVERVIEW: Resource Converter"; echo "  -no-preprocess"; exit 0;; esac
prev=""
for a in "$@"; do
  if [ "$prev" = "/fo" ] || [ "$prev" = "-fo" ]; then : > "$a"; fi
  prev="$a"
done
exit 0
