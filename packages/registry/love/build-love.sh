#!/usr/bin/env bash
#
# Build the native Kandelo framebuffer LÖVE runtime.
#
# This intentionally does not use Emscripten. The result is a POSIX/Wasm
# program linked by wasm32posix-c++ that opens /dev/fb0 at runtime.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
SRC="$HERE/love-src"
BYTEPATH_SRC="$HERE/bytepath-src"
SNKRX_SRC="$HERE/snkrx-src"
GAME_DEMOS_SRC="$HERE/game-demos"
BUILD="$HERE/build"

LOVE_COMMIT="6eb8d546736d5915a8b5af30b2cf33456dfdcb1a" # 11.5
BYTEPATH_COMMIT="51ee3086ae3369a2c80e4e47d4b62d480af4fe89"
SNKRX_COMMIT="6b93a64d694d59472375467648868ae4521d6706"

source "$REPO_ROOT/sdk/activate.sh"
export WASM_POSIX_SYSROOT="${WASM_POSIX_SYSROOT:-$REPO_ROOT/sysroot}"

find_llvm_bin() {
    if [ -n "${WASM_POSIX_LLVM_DIR:-}" ]; then echo "$WASM_POSIX_LLVM_DIR"; return; fi
    if [ -n "${LLVM_BIN:-}" ]; then echo "$LLVM_BIN"; return; fi
    local brew_prefix
    if brew_prefix=$(brew --prefix llvm 2>/dev/null) && [ -d "$brew_prefix/bin" ]; then
        echo "$brew_prefix/bin"
        return
    fi
    if command -v clang++ >/dev/null 2>&1; then
        dirname "$(command -v clang++)"
        return
    fi
    echo "ERROR: LLVM/clang++ not found. Set WASM_POSIX_LLVM_DIR." >&2
    exit 1
}

LLVM_BIN="$(find_llvm_bin)"
CXX="$LLVM_BIN/clang++"
GLUE_DIR="$REPO_ROOT/libc/glue"
CXXFLAGS_NATIVE=(
    --target=wasm32-unknown-unknown
    --sysroot="$WASM_POSIX_SYSROOT"
    -matomics -mbulk-memory
    -fno-trapping-math
    -fno-exceptions
    -fno-rtti
    -isystem "$WASM_POSIX_SYSROOT/include/c++/v1"
)
LDFLAGS_NATIVE=(
    -nostdlib
    -Wl,--entry=_start
    -Wl,--export=_start
    -Wl,--export=__heap_base
    -Wl,--import-memory
    -Wl,--shared-memory
    -Wl,--max-memory=1073741824
    -Wl,--allow-undefined
    -Wl,--global-base=1114112
    -Wl,--table-base=3
    -Wl,--export-table
    -Wl,--growable-table
    -Wl,--export=__wasm_init_tls
    -Wl,--export=__tls_base
    -Wl,--export=__tls_size
    -Wl,--export=__tls_align
    -Wl,--export=__stack_pointer
    -Wl,--export=__wasm_thread_init
    -Wl,--export=__abi_version
)

LUA_PREFIX="${WASM_POSIX_DEP_LUA_DIR:-}"
if [ -z "$LUA_PREFIX" ]; then
    LUA_PREFIX="$HERE/../lua/lua-install"
    if [ ! -f "$LUA_PREFIX/lib/liblua.a" ] || [ ! -f "$LUA_PREFIX/include/lua.h" ]; then
        echo "==> Building Lua dependency..."
        bash "$HERE/../lua/build-lua.sh"
    fi
fi
if [ ! -f "$LUA_PREFIX/lib/liblua.a" ] || [ ! -f "$LUA_PREFIX/include/lua.h" ]; then
    echo "ERROR: Lua dependency not found at $LUA_PREFIX" >&2
    exit 1
fi

if [ ! -d "$SRC/.git" ]; then
    echo "==> Cloning LÖVE $LOVE_COMMIT..."
    git clone --filter=blob:none https://github.com/love2d/love.git "$SRC"
fi
if [ "$(cd "$SRC" && git rev-parse HEAD)" != "$LOVE_COMMIT" ]; then
    echo "==> Checking out LÖVE $LOVE_COMMIT..."
    (cd "$SRC" && git fetch --depth 1 origin "$LOVE_COMMIT" && git checkout "$LOVE_COMMIT")
fi

if [ ! -d "$BYTEPATH_SRC/.git" ]; then
    echo "==> Cloning BYTEPATH $BYTEPATH_COMMIT..."
    git clone --depth 1 https://github.com/a327ex/BYTEPATH.git "$BYTEPATH_SRC"
fi
if [ "$(cd "$BYTEPATH_SRC" && git rev-parse HEAD)" != "$BYTEPATH_COMMIT" ]; then
    echo "==> Checking out BYTEPATH $BYTEPATH_COMMIT..."
    (cd "$BYTEPATH_SRC" && git fetch --depth 1 origin "$BYTEPATH_COMMIT" && git checkout "$BYTEPATH_COMMIT")
fi

if [ ! -d "$SNKRX_SRC/.git" ]; then
    echo "==> Cloning SNKRX $SNKRX_COMMIT..."
    git clone --depth 1 https://github.com/a327ex/SNKRX.git "$SNKRX_SRC"
fi
if [ "$(cd "$SNKRX_SRC" && git rev-parse HEAD)" != "$SNKRX_COMMIT" ]; then
    echo "==> Checking out SNKRX $SNKRX_COMMIT..."
    (cd "$SNKRX_SRC" && git fetch --depth 1 origin "$SNKRX_COMMIT" && git checkout "$SNKRX_COMMIT")
fi

rm -rf "$BUILD"
mkdir -p "$BUILD"

echo "==> Compiling framebuffer runtime..."
"$CXX" "${CXXFLAGS_NATIVE[@]}" -O2 -std=c++17 \
    -I"$LUA_PREFIX/include" \
    -I"$SRC/src/libraries/lodepng" \
    -c "$HERE/src/lovefb.cpp" -o "$BUILD/lovefb.o"
"$CXX" "${CXXFLAGS_NATIVE[@]}" -O2 -std=c++17 \
    -I"$SRC/src/libraries/lodepng" \
    -c "$SRC/src/libraries/lodepng/lodepng.cpp" -o "$BUILD/lodepng.o"

echo "==> Linking love.wasm..."
"$CXX" "${CXXFLAGS_NATIVE[@]}" -O2 \
    "$BUILD/lovefb.o" "$BUILD/lodepng.o" \
    "$GLUE_DIR/channel_syscall.c" \
    "$GLUE_DIR/compiler_rt.c" \
    "$GLUE_DIR/cxxrt.c" \
    "$WASM_POSIX_SYSROOT/lib/crt1.o" \
    "$LUA_PREFIX/lib/liblua.a" \
    "$WASM_POSIX_SYSROOT/lib/libc++.a" \
    "$WASM_POSIX_SYSROOT/lib/libc++abi.a" \
    "$WASM_POSIX_SYSROOT/lib/libc.a" \
    "${LDFLAGS_NATIVE[@]}" \
    -o "$HERE/love.wasm"

echo "==> Bundling Love game demos..."
EXAMPLES_BUILD="$BUILD/examples"
BYTEPATH_BUILD="$EXAMPLES_BUILD/bytepath"
SNKRX_BUILD="$EXAMPLES_BUILD/snkrx"
mkdir -p "$EXAMPLES_BUILD" "$BYTEPATH_BUILD" "$SNKRX_BUILD"
cp -R "$GAME_DEMOS_SRC"/. "$EXAMPLES_BUILD"/

cp "$BYTEPATH_SRC"/GameObject.lua "$BYTEPATH_BUILD"/
cp "$BYTEPATH_SRC"/LICENSE "$BYTEPATH_BUILD"/
cp "$BYTEPATH_SRC"/README.md "$BYTEPATH_BUILD"/
cp "$BYTEPATH_SRC"/conf.lua "$BYTEPATH_BUILD"/
cp "$BYTEPATH_SRC"/globals.lua "$BYTEPATH_BUILD"/
cp "$BYTEPATH_SRC"/main.lua "$BYTEPATH_BUILD"/
cp "$BYTEPATH_SRC"/tree.lua "$BYTEPATH_BUILD"/
cp "$BYTEPATH_SRC"/utils.lua "$BYTEPATH_BUILD"/
cp -R "$BYTEPATH_SRC"/objects "$BYTEPATH_BUILD"/objects
cp -R "$BYTEPATH_SRC"/rooms "$BYTEPATH_BUILD"/rooms
mkdir -p "$BYTEPATH_BUILD"/libraries "$BYTEPATH_BUILD"/resources
for lib in classic enhanced_timer boipushy moses hump draft mlib grid STALKER-X chrono HC; do
    cp -R "$BYTEPATH_SRC/libraries/$lib" "$BYTEPATH_BUILD/libraries/$lib"
done
cp "$BYTEPATH_SRC"/libraries/sound.lua "$BYTEPATH_BUILD"/libraries/sound.lua
cp "$BYTEPATH_SRC"/libraries/utf8.lua "$BYTEPATH_BUILD"/libraries/utf8.lua
cp -R "$BYTEPATH_SRC"/resources/shaders "$BYTEPATH_BUILD"/resources/shaders

cat > "$BYTEPATH_BUILD/libraries/windfield.lua" <<'LUA'
local wf = {}
function wf.newWorld()
  return {destroy = function() end}
end
return wf
LUA

cat > "$BYTEPATH_BUILD/kandelo_compat.lua" <<'LUA'
local shader_names = {'combine', 'displacement', 'distort', 'flat_color', 'glitch', 'grayscale', 'rgb', 'rgb_shift'}

function loadFonts(_)
  fonts = {}
  for i = 8, 16 do
    fonts['Anonymous_' .. i] = love.graphics.newFont(i)
    fonts['Arch_' .. i] = love.graphics.newFont(i)
    fonts['m5x7_' .. i] = love.graphics.newFont(i)
  end
end

function loadGraphics(_)
  assets = {
    shockwave_displacement = {
      getWidth = function() return 128 end,
      getHeight = function() return 128 end,
      getDimensions = function() return 128, 128 end,
    },
  }
end

function loadShaders(_)
  shaders = {}
  for _, name in ipairs(shader_names) do shaders[name] = love.graphics.newShader('') end
end

bitser = bitser or {}
bitser.dumpLoveFile = bitser.dumpLoveFile or function() end
bitser.loadLoveFile = bitser.loadLoveFile or function() return {} end
bitser.dumps = bitser.dumps or function() return '', 0 end
bitser.loads = bitser.loads or function() return {} end
binser = binser or {serialize = function() return '' end, deserialize = function() return {} end}

function load()
  setPermanentGlobals()
  setTransientGlobals()
  first_run_ever = false
end
LUA

perl -0pi -e "s/^Steam = require 'libraries\\/steamworks'\\nif type\\(Steam\\) == 'boolean' then Steam = nil end/Steam = nil/m" "$BYTEPATH_BUILD/main.lua"
perl -0pi -e "s/^bitser = require 'libraries\\/bitser\\/bitser'/bitser = {dumpLoveFile = function() end, loadLoveFile = function() return {} end, dumps = function() return '', 0 end, loads = function() return {} end}/m" "$BYTEPATH_BUILD/main.lua"
perl -0pi -e "s/^binser = require 'libraries\\/binser\\/binser'/binser = {serialize = function() return '' end, deserialize = function() return {} end}/m" "$BYTEPATH_BUILD/main.lua"
perl -0pi -e "s/^ffi = require\\('ffi'\\)/ffi = nil/m" "$BYTEPATH_BUILD/main.lua"
printf '\nrequire "kandelo_compat"\n' >> "$BYTEPATH_BUILD/main.lua"

find "$BYTEPATH_BUILD" -name '*.lua' -print0 | xargs -0 perl -0pi -e 's/goto continue/return/g; s/^[ \t]*::continue::[ \t]*\n//mg'

cp "$SNKRX_SRC"/LICENSE "$SNKRX_BUILD"/
cp "$SNKRX_SRC"/README.md "$SNKRX_BUILD"/
cp "$SNKRX_SRC"/conf.lua "$SNKRX_BUILD"/
cp "$SNKRX_SRC"/main.lua "$SNKRX_BUILD"/
cp "$SNKRX_SRC"/arena.lua "$SNKRX_BUILD"/
cp "$SNKRX_SRC"/buy_screen.lua "$SNKRX_BUILD"/
cp "$SNKRX_SRC"/enemies.lua "$SNKRX_BUILD"/
cp "$SNKRX_SRC"/mainmenu.lua "$SNKRX_BUILD"/
cp "$SNKRX_SRC"/media.lua "$SNKRX_BUILD"/
cp "$SNKRX_SRC"/objects.lua "$SNKRX_BUILD"/
cp "$SNKRX_SRC"/player.lua "$SNKRX_BUILD"/
cp "$SNKRX_SRC"/shared.lua "$SNKRX_BUILD"/
cp -R "$SNKRX_SRC"/engine "$SNKRX_BUILD"/engine
rm -rf "$SNKRX_BUILD"/engine/love
mkdir -p "$SNKRX_BUILD"/assets/images "$SNKRX_BUILD"/assets/fonts "$SNKRX_BUILD"/assets/sounds "$SNKRX_BUILD"/assets/shaders
cp -R "$SNKRX_SRC"/assets/shaders/. "$SNKRX_BUILD"/assets/shaders/

cat > "$SNKRX_BUILD/luasteam.lua" <<'LUA'
local function noop() end
return {
  init = noop,
  shutdown = noop,
  runCallbacks = noop,
  friends = {setRichPresence = noop},
  userStats = {
    requestCurrentStats = noop,
    setAchievement = noop,
    storeStats = noop,
    resetAllStats = noop,
  },
}
LUA

cat > "$SNKRX_BUILD/kandelo_compat.lua" <<'LUA'
web = true

local function noop() end
steam = steam or require('luasteam')

if love.mouse then
  love.mouse.setGrabbed = love.mouse.setGrabbed or noop
  love.mouse.getSystemCursor = love.mouse.getSystemCursor or function() return {} end
end
if love.audio then love.audio.setEffect = love.audio.setEffect or noop end

if system then
  function system.load_state() state = {} end
  function system.save_state() end
  function system.save_run() end
  function system.load_run() return {} end
end

if Font then
  function Font:init(_, font_size)
    self.font = love.graphics.newFont(font_size or 8)
    self.h = self.font:getHeight()
  end
end

if Image then
  local placeholder_image
  function Image:init(_)
    if not placeholder_image then
      placeholder_image = love.graphics.newImage(love.image.newImageData(8, 8))
    end
    self.image = placeholder_image
    self.w, self.h = 8, 8
  end
end

if Random then
  local random_table = Random.table
  local random_table_remove = Random.table_remove
  local random_int = Random.int
  function Random:table(t)
    if not t or #t == 0 then return nil end
    return random_table(self, t)
  end
  function Random:table_remove(t)
    if not t or #t == 0 then return nil end
    return random_table_remove(self, t)
  end
  function Random:int(min, max)
    min, max = min or 0, max or 1
    if min > max then min, max = max, min end
    return random_int(self, min, max)
  end
end

local sound_instance = {}
sound_instance.__index = sound_instance
function sound_instance:play(options)
  self.stopped = false
  self.volume = options and options.volume or self.volume or 1
  self.pitch = options and options.pitch or self.pitch or 1
  return self
end
function sound_instance:stop() self.stopped = true end
function sound_instance:pause() self.stopped = true end
function sound_instance:isStopped() return self.stopped == true end

local sound_object = {}
sound_object.__index = sound_object
function sound_object:play(options)
  return setmetatable({
    stopped = false,
    volume = options and options.volume or 1,
    pitch = options and options.pitch or 1,
  }, sound_instance)
end
function sound_object:stop() end
function sound_object:pause() end

function Sound(_, _) return setmetatable({}, sound_object) end
function SoundTag(_) return {volume = 1} end
Effect = noop

local fixed_dt = 1/60
local load_error = nil

local function init_engine_callbacks()
  state = state or {}
  gw, gh = 480, 270
  sx, sy = 2, 2
  ww, wh = 960, 540
  msaa = 0
  refresh_rate = 60
  slow_amount = 1
  music_slow_amount = 1

  love.graphics.setBackgroundColor(0, 0, 0, 1)
  love.graphics.setColor(1, 1, 1, 1)
  graphics.set_line_style('rough')
  graphics.set_default_filter('nearest', 'nearest')

  combine = Shader('default.vert', 'combine.frag')
  replace = Shader('default.vert', 'replace.frag')
  full_combine = Shader('default.vert', 'full_combine.frag')

  input = Input()
  input:bind_all()
  input:bind('move_left', {'a', 'left', 'dpleft', 'm1'})
  input:bind('move_right', {'d', 'e', 's', 'right', 'dpright', 'm2'})
  input:bind('enter', {'space', 'return', 'fleft', 'fdown', 'fright'})

  random = Random()
  trigger = Trigger()
  camera = Camera(gw/2, gh/2)
  mouse = Vector(0, 0)
  last_mouse = Vector(0, 0)
  mouse_dt = Vector(0, 0)
  init()
  frame, time = 0, 0
end

function love.load()
  local ok, err = xpcall(init_engine_callbacks, debug.traceback)
  if not ok then load_error = err end
end

function love.update(_)
  if load_error then return end
  if not main then return end
  local ok, err = xpcall(function()
    frame = frame + 1
    input:update(fixed_dt)
    trigger:update(fixed_dt)
    camera:update(fixed_dt)
    local mx, my = love.mouse.getPosition()
    mouse:set(mx/sx, my/sy)
    mouse_dt:set(mouse.x - last_mouse.x, mouse.y - last_mouse.y)
    update(fixed_dt)
    system.update()
    input.last_key_pressed = nil
    last_mouse:set(mouse.x, mouse.y)
    time = time + fixed_dt
  end, debug.traceback)
  if not ok then load_error = err end
end

function love.draw()
  if load_error then
    love.graphics.setColor(1, 0.25, 0.25, 1)
    love.graphics.print(load_error, 12, 12)
    return
  end
  if main then draw() end
end

function love.keypressed(key)
  if main and main.current and MainMenu and main.current.is and main.current:is(MainMenu)
      and (key == 'return' or key == 'space')
      and main.current.arena_run_button and main.current.arena_run_button.action then
    main.current.arena_run_button:action()
    return
  end
  if main and main.current and BuyScreen and main.current.is and main.current:is(BuyScreen)
      and (key == 'return' or key == 'space') and not main.current.kandelo_starting
      and main.current.units and #main.current.units > 0 then
    local current = main.current
    current.kandelo_starting = true
    main:add(Arena'arena')
    main:go_to('arena', current.level, current.loop, current.units, current.passives, current.shop_level, current.shop_xp, current.locked)
    return
  end
  if input then input.keyboard_state[key] = true; input.last_key_pressed = key end
end

function love.keyreleased(key)
  if input then input.keyboard_state[key] = false end
end

function love.mousepressed(_, _, button)
  if input and input.mouse_buttons[button] then
    input.mouse_state[input.mouse_buttons[button]] = true
    input.last_key_pressed = input.mouse_buttons[button]
  end
end

function love.mousereleased(_, _, button)
  if input and input.mouse_buttons[button] then input.mouse_state[input.mouse_buttons[button]] = false end
end
LUA

printf '\nrequire "kandelo_compat"\n' >> "$SNKRX_BUILD/main.lua"
find "$SNKRX_BUILD" -name '*.lua' -print0 | xargs -0 perl -0pi -e 's/goto continue/return/g; s/^[ \t]*::continue::[ \t]*\n//mg'

rm -f "$HERE/love-examples.zip"
(cd "$EXAMPLES_BUILD" && zip -qr "$HERE/love-examples.zip" . -x '*.DS_Store')

ls -lh "$HERE/love.wasm" "$HERE/love-examples.zip"

cd "$REPO_ROOT"
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary love "$HERE/love.wasm"
install_local_binary love "$HERE/love-examples.zip"

# Keep direct ad-hoc builds useful even in minimal environments without cargo,
# where install-local-binary.sh cannot ask xtask for multi-output paths.
ARCH="${WASM_POSIX_DEP_TARGET_ARCH:-wasm32}"
mkdir -p "$REPO_ROOT/local-binaries/programs/$ARCH/love"
cp "$HERE/love.wasm" "$REPO_ROOT/local-binaries/programs/$ARCH/love/love.wasm"
cp "$HERE/love-examples.zip" "$REPO_ROOT/local-binaries/programs/$ARCH/love/love-examples.zip"
