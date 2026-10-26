#!/usr/bin/env bash
set -euo pipefail

extension_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
repo_dir="$(cd -- "$extension_dir/.." && pwd)"
output_dir="${1:-$repo_dir/artifacts}"
manifest="$extension_dir/manifest.json"
build_dir="$extension_dir/dist"
website_archive="$repo_dir/marketing/public/extension/cuecast-extension.zip"

if [[ ! -d "$extension_dir/node_modules/esbuild" ]]; then
  echo "Extension build dependency is missing. Run: (cd extension && npm ci)" >&2
  exit 1
fi

(
  cd "$extension_dir"
  npm run build
)

version="$(node -e "const m=require(process.argv[1]); process.stdout.write(m.version)" "$manifest")"
default_locale="$(node -e "const m=require(process.argv[1]); process.stdout.write(m.default_locale || '')" "$manifest")"

if [[ -z "$version" || -z "$default_locale" ]]; then
  echo "manifest.json must contain version and default_locale" >&2
  exit 1
fi

for locale in en zh_CN; do
  node -e "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'))" \
    "$extension_dir/_locales/$locale/messages.json"
done

if rg -n "https://fonts\\.(googleapis|gstatic)\\.com|<script[^>]+src=['\"]https?://" \
  "$build_dir" --glob '*.html' --glob '*.js' >/dev/null; then
  echo "Remote executable or font resources are not allowed in the store package" >&2
  exit 1
fi

temp_dir="$(mktemp -d)"
trap 'rm -rf -- "$temp_dir"' EXIT
package_dir="$temp_dir/package"
mkdir -p "$package_dir" "$output_dir"

cp -R "$build_dir/." "$package_dir/"

archive="$output_dir/cuecast-extension-v$version.zip"
rm -f -- "$archive"
(
  cd "$package_dir"
  zip -qr "$archive" .
)

if ! unzip -Z1 "$archive" | awk '$0 == "manifest.json" { found = 1 } END { exit !found }'; then
  echo "Package root is invalid: manifest.json must be at the ZIP root" >&2
  exit 1
fi

if unzip -Z1 "$archive" | rg '(^modules/|\.map$)'; then
  echo "Package must not include source modules or source maps" >&2
  exit 1
fi

echo "Created $archive"
shasum -a 256 "$archive"

mkdir -p "$(dirname -- "$website_archive")"
cp "$archive" "$website_archive"
echo "Updated $website_archive"
