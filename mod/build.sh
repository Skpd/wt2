#!/usr/bin/env bash
# Builds every plugin in mod/<name>/*.cs into mod/<name>/WT2<Name>.dll against the installed game and BepInEx.
#   ./build.sh [--install|--dev] [plugin...]     (default: all plugins)
#     --install  copy into BepInEx/plugins (loaded once at startup)
#     --dev      copy into BepInEx/scripts and hot-reload in the running game via ScriptEngine
#                (installed and configured on first use; reload key F11, auto-reload on file change)
#   GAME         - game install dir (default: Steam library path below)
#   BEPINEX_CORE - dir with BepInEx.dll and 0Harmony.dll (default: $GAME/BepInEx/core)
set -euo pipefail
cd "$(dirname "$0")"
GAME="${GAME:-/opt/steam/steamapps/common/Wild Terra 2}"
M="$GAME/Wild-Terra-2_Data/Managed"
BEP="$GAME/BepInEx"
CORE="${BEPINEX_CORE:-$BEP/core}"
SCRIPTENGINE_URL="https://github.com/BepInEx/BepInEx.Debug/releases/download/r11.1/ScriptEngine_r11.1.zip"

mode=""
if [[ "${1:-}" == "--install" || "${1:-}" == "--dev" ]]; then mode="$1"; shift; fi
plugins=("$@")
if [[ ${#plugins[@]} -eq 0 ]]; then
    for d in */; do ls "$d"*.cs >/dev/null 2>&1 && plugins+=("${d%/}"); done
fi

setup_scriptengine() {
    if [[ ! -f "$BEP/plugins/ScriptEngine.dll" ]]; then
        tmp="$(mktemp -d)"
        curl -sSL -o "$tmp/se.zip" "$SCRIPTENGINE_URL"
        unzip -q -o "$tmp/se.zip" -d "$tmp/se"
        cp "$tmp/se/BepInEx/plugins/ScriptEngine.dll" "$BEP/plugins/"
        rm -rf "$tmp"
        echo "installed ScriptEngine (restart the game once to activate it)"
    fi
    local cfg="$BEP/config/com.bepis.bepinex.scriptengine.cfg"
    if [[ ! -f "$cfg" ]]; then
        mkdir -p "$BEP/config"
        cat > "$cfg" <<'EOF'
[General]
LoadOnStart = true
## F6 is taken by the finder window
ReloadKey = F11
QuietMode = false
IncludeSubdirectories = false

[AutoReload]
EnableFileSystemWatcher = true
AutoReloadDelay = 2
DumpAssemblies = false
EOF
        echo "wrote $cfg"
    fi
    mkdir -p "$BEP/scripts"
}

refs=()
for dll in mscorlib System System.Core netstandard Assembly-CSharp Mirror \
           UnityEngine UnityEngine.CoreModule UnityEngine.IMGUIModule UnityEngine.InputLegacyModule \
           UnityEngine.AIModule UnityEngine.TextRenderingModule UnityEngine.PhysicsModule UnityEngine.UIModule; do
    refs+=("-r:$M/$dll.dll")
done
refs+=("-r:$CORE/BepInEx.dll" "-r:$CORE/0Harmony.dll")

[[ "$mode" == "--dev" ]] && setup_scriptengine

for p in "${plugins[@]}"; do
    name="WT2$(tr '[:lower:]' '[:upper:]' <<< "${p:0:1}")${p:1}.dll"
    mcs -nostdlib -noconfig -target:library -optimize+ -debug -out:"$p/$name" "${refs[@]}" "$p"/*.cs
    echo "built $p/$name"
    case "$mode" in
        --install)
            mkdir -p "$BEP/plugins"
            rm -f "$BEP/scripts/$name" "$BEP/scripts/$name.mdb"
            cp "$p/$name" "$p/$name.mdb" "$BEP/plugins/"
            echo "  installed to $BEP/plugins/" ;;
        --dev)
            # A plugin must live in only one place, or it loads twice.
            # ScriptEngine reads debug symbols and aborts loading everything if a .mdb is missing.
            rm -f "$BEP/plugins/$name" "$BEP/plugins/$name.mdb"
            cp "$p/$name.mdb" "$BEP/scripts/"
            cp "$p/$name" "$BEP/scripts/"
            echo "  copied to $BEP/scripts/ (hot-reloads in a running game)" ;;
    esac
done
