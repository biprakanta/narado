#!/usr/bin/env bash
# Run narado desktop from the source tree (development only).
#
# On macOS the Dock and menu bar take the app's name from the running bundle, so a plain
# `electron .` shows "Electron". This makes a renamed copy of Electron.app (narado.app,
# with narado's name, bundle ID and icon) in node_modules/.cache and runs that instead.
# Packaged builds (desktop phase D4) set all of this in the build.
#
#   scripts/narado-desktop-dev.sh [electron args...]
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
dist="$root/node_modules/electron/dist"
export NARADO_DESKTOP=1
# Run in development mode (interface from the dev server, ELECTRON_USER_DATA_PATH honoured):
# outside node_modules/electron, electron-is-dev would otherwise say "packaged".
export ELECTRON_IS_DEV="${ELECTRON_IS_DEV:-1}"

if [[ "$(uname)" != "Darwin" ]]; then
  exec "$root/node_modules/.bin/electron" "$root/packages/bruno-electron" "$@"
fi

cache="$root/node_modules/.cache/narado-desktop"
app="$cache/narado.app"
version="$(cat "$dist/version")-4"
if [[ ! -f "$cache/version" || "$(cat "$cache/version")" != "$version" ]]; then
  rm -rf "$cache"
  mkdir -p "$cache"
  cp -R "$dist/Electron.app" "$app"
  plist="$app/Contents/Info.plist"
  /usr/libexec/PlistBuddy -c "Set :CFBundleName narado" "$plist"
  /usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName narado" "$plist" 2>/dev/null \
    || /usr/libexec/PlistBuddy -c "Add :CFBundleDisplayName string narado" "$plist"
  /usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier co.narado.desktop.dev" "$plist"
  # narado:// links (OAuth 2 sign-ins finished in the system browser come back this way).
  /usr/libexec/PlistBuddy -c "Delete :CFBundleURLTypes" "$plist" 2>/dev/null || true
  /usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes array" "$plist"
  /usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes:0 dict" "$plist"
  /usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes:0:CFBundleURLName string co.narado.desktop" "$plist"
  /usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes:0:CFBundleURLSchemes array" "$plist"
  /usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string narado" "$plist"
  # The process name comes from the executable, so rename it and the helpers, as Electron's
  # packager does (Electron finds "<executable> Helper*.app" next to it).
  mv "$app/Contents/MacOS/Electron" "$app/Contents/MacOS/narado"
  /usr/libexec/PlistBuddy -c "Set :CFBundleExecutable narado" "$plist"
  for kind in "" " (GPU)" " (Plugin)" " (Renderer)"; do
    old_helper="$app/Contents/Frameworks/Electron Helper$kind.app"
    new_helper="$app/Contents/Frameworks/narado Helper$kind.app"
    [[ -d "$old_helper" ]] || continue
    mv "$old_helper/Contents/MacOS/Electron Helper$kind" "$old_helper/Contents/MacOS/narado Helper$kind"
    hp="$old_helper/Contents/Info.plist"
    for key in CFBundleExecutable CFBundleName CFBundleDisplayName; do
      /usr/libexec/PlistBuddy -c "Set :$key narado Helper$kind" "$hp" 2>/dev/null \
        || /usr/libexec/PlistBuddy -c "Add :$key string narado Helper$kind" "$hp"
    done
    mv "$old_helper" "$new_helper"
  done
  # Icon: an .icns made from the narado app icon.
  set_dir="$cache/narado.iconset"
  mkdir -p "$set_dir"
  src="$root/branding/icons/app-icon-512.png"
  for size in 16 32 128 256 512; do
    sips -z $size $size "$src" --out "$set_dir/icon_${size}x${size}.png" >/dev/null
    double=$((size * 2)); [[ $double -le 512 ]] && sips -z $double $double "$src" --out "$set_dir/icon_${size}x${size}@2x.png" >/dev/null
  done
  iconutil -c icns "$set_dir" -o "$app/Contents/Resources/electron.icns"
  touch "$app"
  echo "$version" > "$cache/version"
  # Copied and edited, the signature no longer matches; sign it again locally.
  codesign --force --deep --sign - "$app" >/dev/null 2>&1 || true
fi

exec "$app/Contents/MacOS/narado" "$root/packages/bruno-electron" "$@"
