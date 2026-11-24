#!/bin/sh
set -u

cd "$(git rev-parse --show-toplevel)" || exit 2
dir=verify/ownership
jar="${XDG_CACHE_HOME:-$HOME/.cache}/mcp-taiga/tla2tools-1.7.4.jar"
sha=936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88

if ! printf '%s  %s\n' "$sha" "$jar" | sha256sum -c --status 2>/dev/null; then
  mkdir -p "$(dirname "$jar")"
  curl -sSfL -o "$jar" https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar || exit 2
  printf '%s  %s\n' "$sha" "$jar" | sha256sum -c --status || { echo "tla2tools.jar checksum mismatch"; exit 2; }
fi

node "$dir/coverage.mjs"
coverage=$?

known="OwnedAtAddonWrite"
holds="OwnedAtFirstPatch OwnedAtRetryPatch NoWriteAfterRefusal"
tmp=$(mktemp -d)
status=0

for inv in $holds $known; do
  sed "\$a INVARIANT $inv" "$dir/WorkUpdateOwnership.cfg" > "$tmp/$inv.cfg"
  java -XX:+UseParallelGC -cp "$jar" tlc2.TLC -workers 1 -cleanup -metadir "$tmp/meta-$inv" \
    -config "$tmp/$inv.cfg" "$dir/WorkUpdateOwnership.tla" > "$tmp/$inv.out" 2>&1

  if grep -q "Invariant $inv is violated" "$tmp/$inv.out"; then result=violated
  elif grep -q "Model checking completed. No error has been found" "$tmp/$inv.out"; then result=holds
  else result=error
  fi

  case " $known " in *" $inv "*) expected=violated ;; *) expected=holds ;; esac

  if [ "$result" = "$expected" ]; then
    label=$([ "$result" = violated ] && echo "known finding" || echo ok)
    echo "$result  $inv  ($label)"
  else
    echo "$result  $inv  (expected $expected)"
    sed -n '/Error:/,/states generated/p' "$tmp/$inv.out"
    status=1
  fi
done

rm -rf "$tmp"
[ "$coverage" -ne 0 ] && status=1
exit "$status"
