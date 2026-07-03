#!/usr/bin/env bash
#
# Build the native Kandelo LÖVE runtime.
#
# This intentionally does not use Emscripten. The result is a POSIX/Wasm
# program linked by wasm32posix-c++ that prefers /dev/dri/card0 KMS/EGL/GLES
# presentation and falls back to /dev/fb0 when direct rendering is unavailable.

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
LIBCXX_PREFIX="${WASM_POSIX_DEP_LIBCXX_DIR:-$WASM_POSIX_SYSROOT}"
if [ ! -f "$LIBCXX_PREFIX/lib/libc++.a" ] ||
   [ ! -f "$LIBCXX_PREFIX/lib/libc++abi.a" ] ||
   [ ! -f "$LIBCXX_PREFIX/include/c++/v1/algorithm" ]; then
    echo "ERROR: libcxx dependency not found at $LIBCXX_PREFIX" >&2
    echo "Resolve libcxx first or build through cargo xtask build-deps resolve love." >&2
    exit 1
fi
CXXFLAGS_NATIVE=(
    --target=wasm32-unknown-unknown
    --sysroot="$WASM_POSIX_SYSROOT"
    -matomics -mbulk-memory
    -fno-trapping-math
    -fno-exceptions
    -fno-rtti
    -isystem "$LIBCXX_PREFIX/include/c++/v1"
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

DRI_LIBS=(
    "$WASM_POSIX_SYSROOT/lib/libgbm.a"
    "$WASM_POSIX_SYSROOT/lib/libdrm.a"
    "$WASM_POSIX_SYSROOT/lib/libEGL.a"
    "$WASM_POSIX_SYSROOT/lib/libGLESv2.a"
)
for lib in "${DRI_LIBS[@]}"; do
    if [ ! -f "$lib" ]; then
        echo "ERROR: DRI/EGL/GLES sysroot library is missing: $lib" >&2
        echo "Run: scripts/dev-shell.sh bash scripts/build-musl.sh" >&2
        exit 1
    fi
done

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

echo "==> Compiling KMS/EGL/GLES runtime..."
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
    "${DRI_LIBS[@]}" \
    "$LIBCXX_PREFIX/lib/libc++.a" \
    "$LIBCXX_PREFIX/lib/libc++abi.a" \
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

local function normalize_units(units)
  units = units or {}
  for _, unit in ipairs(units) do
    unit.reserve = unit.reserve or {0, 0}
    unit.reserve[1] = unit.reserve[1] or 0
    unit.reserve[2] = unit.reserve[2] or 0
  end
  return units
end

if system then
  function system.load_state() state = {} end
  function system.save_state() end
  function system.save_run() end
  function system.load_run()
    local run = {
      level = 1,
      loop = 0,
      gold = 3,
      shop_level = 1,
      shop_xp = 0,
      units = {
        {character = 'vagrant', level = 1, reserve = {0, 0}},
        {character = 'swordsman', level = 1, reserve = {0, 0}},
        {character = 'archer', level = 1, reserve = {0, 0}},
      },
      passives = {},
    }
    run.units = normalize_units(run.units)
    return run
  end
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

if class_set_numbers then
  for class, get_numbers in pairs(class_set_numbers) do
    local original_get_numbers = get_numbers
    class_set_numbers[class] = function(units)
      local i, j, k, n = original_get_numbers(normalize_units(units))
      return i or 1, j or i or 1, k, n or 0
    end
  end
end

if BuyScreen then
  if BuyScreen.on_enter then
    local on_enter = BuyScreen.on_enter
    function BuyScreen:on_enter(from, level, loop, units, passives, shop_level, shop_xp)
      return on_enter(self, from, level, loop, normalize_units(units), passives, shop_level, shop_xp)
    end
  end
  if BuyScreen.buy then
    local buy = BuyScreen.buy
    function BuyScreen:buy(character, i)
      self.units = normalize_units(self.units)
      return buy(self, character, i)
    end
  end
end

local fixed_dt = 1/60
local load_error = nil
local arena_transition_frames = 0
local arena_demo_frames = 0
local arena_demo_targets = {}
local arena_demo_score = 0
local arena_demo_hit_flash = 0
local arena_demo_hit_x, arena_demo_hit_y = nil, nil
local arena_demo_snake = nil
local arena_demo_attack_timer = 0
local arena_demo_bursts = {}
local arena_demo_shot = nil

local function is_current_arena()
  return main and main.current and main.current.is and Arena and main.current:is(Arena)
end

local function sync_mouse_visibility()
  if not love.mouse or not main or not main.current or not main.current.is then return end
  if MainMenu and main.current:is(MainMenu) then
    love.mouse.setVisible(true)
  elseif BuyScreen and main.current:is(BuyScreen) then
    love.mouse.setVisible(true)
  elseif Arena and main.current:is(Arena) then
    love.mouse.setVisible(true)
  end
end

local function clear_group_objects(group)
  if not group or not group.objects then return end
  for i = #group.objects, 1, -1 do table.remove(group.objects, i) end
  group.objects.by_id = {}
  group.objects.by_class = {}
end

local function clear_stuck_arena_transition()
  if not is_current_arena() then
    arena_transition_frames = 0
    return
  end
  arena_transition_frames = arena_transition_frames + 1
  if arena_transition_frames > 45 and main.transitions and main.transitions.objects and #main.transitions.objects > 0 then
    clear_group_objects(main.transitions)
  end
end

local function keep_arena_visible()
  if not is_current_arena() then return end
  local arena = main.current
  if camera then
    camera.x, camera.y, camera.r = gw/2, gh/2, 0
  end
  if not arena.main or not arena.main.objects then return end
  local x1, y1 = (arena.x1 or 0) + 12, (arena.y1 or 0) + 12
  local x2, y2 = (arena.x2 or gw) - 12, (arena.y2 or gh) - 12
  for _, object in ipairs(arena.main.objects) do
    local keep = (Player and object.is and object:is(Player))
      or (Seeker and object.is and object:is(Seeker))
      or (EnemyCritter and object.is and object:is(EnemyCritter))
    if keep and object.set_position then
      local x, y = object.x, object.y
      if object.get_position then
        local px, py = object:get_position()
        if px and py then x, y = px, py end
      end
      if x and y then
        local r = object.r or 0
        local bounced = false
        if x < x1 then x, r, bounced = x1, math.pi - r, true end
        if x > x2 then x, r, bounced = x2, math.pi - r, true end
        if y < y1 then y, r, bounced = y1, -r, true end
        if y > y2 then y, r, bounced = y2, -r, true end
        if bounced then
          object.r = r
          object:set_position(x, y)
          if object.set_velocity then
            local speed = object.total_v or object.max_v or object.v or 80
            object:set_velocity(speed*math.cos(r), speed*math.sin(r))
          end
        end
      end
    end
  end
end

local function clamp_value(value, min_value, max_value)
  if value ~= value then return (min_value + max_value)/2 end
  if value < min_value then return min_value end
  if value > max_value then return max_value end
  return value
end

local function angle_delta(from, to)
  return (to - from + math.pi) % (2*math.pi) - math.pi
end

local function arena_object_position(object)
  local x, y = object.x, object.y
  if object.get_position then
    local px, py = object:get_position()
    if px and py then x, y = px, py end
  end
  return x, y
end

local function draw_screen_box(x, y, w, h, r, g, b)
  love.graphics.setColor(r, g, b, 1)
  love.graphics.rectangle('fill', math.floor(x - w/2), math.floor(y - h/2), math.floor(w), math.floor(h))
end

local function set_actor_pose(actor, x, y, r)
  actor.x, actor.y, actor.r = x, y, r
  if actor.set_position then actor:set_position(x, y) end
  if actor.set_angle then actor:set_angle(r) end
end

local function demo_fraction(seed)
  local value = math.sin(seed)*10000
  return value - math.floor(value)
end

local function spawn_arena_demo_target(arena, slot, avoid_x, avoid_y)
  local x1, y1 = (arena.x1 or 0) + 16, (arena.y1 or 0) + 16
  local x2, y2 = (arena.x2 or gw) - 16, (arena.y2 or gh) - 16
  local width = math.max(1, x2 - x1)
  local height = math.max(1, y2 - y1)
  local target = {x = x1 + width/2, y = y1 + height/2, phase = slot}
  for attempt = 1, 10 do
    local seed = (arena_demo_score + 1)*37 + slot*101 + attempt*53 + arena_demo_frames*0.031
    target.x = x1 + demo_fraction(seed*12.9898)*width
    target.y = y1 + demo_fraction(seed*78.233)*height
    target.phase = demo_fraction(seed*0.731)*2*math.pi
    if not avoid_x then break end
    local dx, dy = target.x - avoid_x, target.y - avoid_y
    if dx*dx + dy*dy > 150*150 then break end
  end
  arena_demo_targets[slot] = target
end

local function reset_arena_demo_targets()
  arena_demo_targets = {}
  arena_demo_score = 0
  arena_demo_hit_flash = 0
  arena_demo_hit_x, arena_demo_hit_y = nil, nil
  arena_demo_snake = nil
  arena_demo_attack_timer = 0
  arena_demo_bursts = {}
  arena_demo_shot = nil
  if not is_current_arena() then return end
  local arena = main.current
  local avoid_x, avoid_y
  if arena.player then avoid_x, avoid_y = arena_object_position(arena.player) end
  for i = 1, 6 do spawn_arena_demo_target(arena, i, avoid_x, avoid_y) end
end

local function demo_actor_position(actor)
  if actor.get_position then return arena_object_position(actor) end
  return actor.x, actor.y
end

local function collect_arena_demo_target(arena, slot, avoid_x, avoid_y)
  local target = arena_demo_targets[slot]
  if not target then return end
  arena_demo_score = arena_demo_score + 1
  arena_demo_hit_flash = 0.8
  arena_demo_hit_x, arena_demo_hit_y = target.x, target.y
  arena_demo_shot = {x1 = avoid_x or target.x, y1 = avoid_y or target.y, x2 = target.x, y2 = target.y, t = 0.18}
  table.insert(arena_demo_bursts, {x = target.x, y = target.y, t = 0.45})
  if #arena_demo_bursts > 8 then table.remove(arena_demo_bursts, 1) end
  spawn_arena_demo_target(arena, slot, avoid_x, avoid_y)
end

local function update_arena_demo_targets(arena, actors, dt)
  if #arena_demo_targets == 0 then reset_arena_demo_targets() end
  arena_demo_hit_flash = math.max(0, arena_demo_hit_flash - dt)
  arena_demo_attack_timer = arena_demo_attack_timer + dt
  if arena_demo_shot then
    arena_demo_shot.t = arena_demo_shot.t - dt
    if arena_demo_shot.t <= 0 then arena_demo_shot = nil end
  end
  for i = #arena_demo_bursts, 1, -1 do
    arena_demo_bursts[i].t = arena_demo_bursts[i].t - dt
    if arena_demo_bursts[i].t <= 0 then table.remove(arena_demo_bursts, i) end
  end

  for i, target in ipairs(arena_demo_targets) do
    target.phase = (target.phase or 0) + 3*dt
    for _, actor in ipairs(actors) do
      local ax, ay = demo_actor_position(actor)
      if ax and ay then
        local dx, dy = target.x - ax, target.y - ay
        if dx*dx + dy*dy <= 42*42 then
          collect_arena_demo_target(arena, i, ax, ay)
          break
        end
      end
    end
  end

  if arena_demo_attack_timer >= 1.15 and actors[1] then
    arena_demo_attack_timer = 0
    local ax, ay = demo_actor_position(actors[1])
    local best_i, best_d = nil, nil
    if ax and ay then
      for i, target in ipairs(arena_demo_targets) do
        local dx, dy = target.x - ax, target.y - ay
        local d = dx*dx + dy*dy
        if not best_d or d < best_d then best_i, best_d = i, d end
      end
    end
    if best_i then collect_arena_demo_target(arena, best_i, ax, ay) end
  end
end

local function draw_arena_demo_background(arena)
  local w, h = gw*sx, gh*sy
  love.graphics.setColor(0.11, 0.13, 0.14, 1)
  love.graphics.rectangle('fill', 0, 0, w, h)
  love.graphics.setColor(0.19, 0.22, 0.23, 1)
  for y = 0, h, 32 do love.graphics.line(0, y, w, y) end
  for x = 0, w, 32 do love.graphics.line(x, 0, x, h) end

  local x1, y1 = ((arena.x1 or 0) + 2)*sx, ((arena.y1 or 0) + 2)*sy
  local x2, y2 = ((arena.x2 or gw) - 2)*sx, ((arena.y2 or gh) - 2)*sy
  local hud_h = math.max(54, y1 - 22)
  love.graphics.setColor(0.14, 0.12, 0.10, 1)
  love.graphics.rectangle('fill', 16, 14, w - 32, hud_h)
  love.graphics.setColor(0.54, 0.32, 0.22, 1)
  love.graphics.rectangle('line', 16, 14, w - 32, hud_h)
  love.graphics.setColor(0.82, 0.94, 0.72, 1)
  love.graphics.print('SNKRX', 32, 28)
  love.graphics.print('wave 1', 32, 50)
  love.graphics.print('hits ' .. tostring(arena_demo_score), 112, 50)
  love.graphics.print('units', 218, 50)
  local unit_colors = {
    {0.20, 0.95, 0.45}, {0.35, 0.65, 0.95}, {0.82, 0.42, 0.95},
    {0.96, 0.82, 0.24}, {0.95, 0.42, 0.22}, {0.40, 0.88, 0.82},
  }
  for i, color in ipairs(unit_colors) do
    local ux = 270 + (i - 1)*44
    love.graphics.setColor(color[1], color[2], color[3], 1)
    love.graphics.rectangle('fill', ux, 42, 26, 24)
    love.graphics.setColor(0.84, 0.66, 0.38, 1)
    love.graphics.rectangle('line', ux, 42, 26, 24)
  end

  love.graphics.setColor(0.18, 0.20, 0.21, 1)
  love.graphics.rectangle('fill', x1, y1, x2 - x1, y2 - y1)
  love.graphics.setColor(0.54, 0.32, 0.22, 1)
  love.graphics.rectangle('line', x1, y1, x2 - x1, y2 - y1)
  love.graphics.setColor(0.26, 0.29, 0.30, 1)
  love.graphics.line(x1, (y1 + y2)/2, x2, (y1 + y2)/2)
  love.graphics.line((x1 + x2)/2, y1, (x1 + x2)/2, y2)

  local t = time or 0
  for i = 1, 28 do
    local px = (demo_fraction(i*17.13)*w + t*12*(i % 3 + 1)) % w
    local py = demo_fraction(i*41.7)*h
    local c = 0.18 + 0.12*demo_fraction(i*5.31)
    love.graphics.setColor(c, c + 0.02, c + 0.04, 1)
    love.graphics.rectangle('fill', math.floor(px), math.floor(py), 2, 2)
  end
end

local function update_arena_demo_motion(dt)
  if not is_current_arena() then return end
  local arena = main.current
  local leader = arena.player

  local x1, y1 = (arena.x1 or 0) + 12, (arena.y1 or 0) + 12
  local x2, y2 = (arena.x2 or gw) - 12, (arena.y2 or gh) - 12
  local x, y = leader and arena_object_position(leader) or gw/2, gh/2
  if arena_demo_snake then x, y = arena_demo_snake.x, arena_demo_snake.y end
  x = clamp_value(x or gw/2, x1, x2)
  y = clamp_value(y or gh/2, y1, y2)

  local mx = clamp_value((mouse and mouse.x) or gw/2, x1, x2)
  local my = clamp_value((mouse and mouse.y) or gh/2, y1, y2)
  local r = (arena_demo_snake and arena_demo_snake.r) or (leader and leader.r) or math.atan2(my - y, mx - x)
  local desired = math.atan2(my - y, mx - x)
  local max_turn = 1.66*math.pi*dt
  local turn = clamp_value(angle_delta(r, desired), -max_turn, max_turn)
  r = r + turn

  local speed = (arena_demo_snake and arena_demo_snake.speed) or (leader and (leader.total_v or leader.max_v)) or 82
  if leader and leader.get_all_units then
    local ok, units = pcall(function() return leader:get_all_units() end)
    if ok and units and #units > 0 then
      local total = 0
      for _, unit in ipairs(units) do total = total + (unit.max_v or speed) end
      speed = total/#units
    end
  end

  x = x + speed*math.cos(r)*dt
  y = y + speed*math.sin(r)*dt
  if x < x1 then x, r = x1, math.pi - r end
  if x > x2 then x, r = x2, math.pi - r end
  if y < y1 then y, r = y1, -r end
  if y > y2 then y, r = y2, -r end

  arena_demo_snake = arena_demo_snake or {positions = {}}
  arena_demo_snake.x, arena_demo_snake.y, arena_demo_snake.r, arena_demo_snake.speed = x, y, r, speed
  table.insert(arena_demo_snake.positions, 1, {x = x, y = y, r = r})
  if #arena_demo_snake.positions > 256 then arena_demo_snake.positions[257] = nil end
  arena_demo_snake.segments = {{x = x, y = y, r = r}}
  for i = 1, 2 do
    local p = arena_demo_snake.positions[math.min(#arena_demo_snake.positions, math.max(1, math.floor(12*i)))]
    if p then table.insert(arena_demo_snake.segments, {x = p.x, y = p.y, r = p.r}) end
  end

  if leader then
    leader.total_v = speed
    set_actor_pose(leader, x, y, r)
    if leader.set_velocity then leader:set_velocity(speed*math.cos(r), speed*math.sin(r)) end
    leader.previous_positions = leader.previous_positions or {}
    table.insert(leader.previous_positions, 1, {x = x, y = y, r = r})
    if #leader.previous_positions > 256 then leader.previous_positions[257] = nil end
  end

  if leader and leader.followers then
    for i, follower in ipairs(leader.followers) do
      local p = leader.previous_positions[math.min(#leader.previous_positions, math.max(1, math.floor(10.4*i)))]
      if p then
        set_actor_pose(follower, p.x, p.y, p.r)
        if follower.set_velocity then follower:set_velocity(speed*math.cos(p.r), speed*math.sin(p.r)) end
        follower.following = true
      end
    end
  end
  local target_actors = {}
  for _, segment in ipairs(arena_demo_snake.segments) do table.insert(target_actors, segment) end
  if mouse then table.insert(target_actors, {x = mouse.x, y = mouse.y}) end
  update_arena_demo_targets(arena, target_actors, dt)
end

local function draw_arena_demo_snake()
  if not arena_demo_snake or not arena_demo_snake.segments then return false end
  if arena_demo_snake.positions then
    love.graphics.setColor(0.24, 0.48, 0.44, 1)
    for i = 2, math.min(#arena_demo_snake.positions, 42), 2 do
      local p = arena_demo_snake.positions[i]
      love.graphics.rectangle('fill', math.floor(p.x*sx - 3), math.floor(p.y*sy - 3), 6, 6)
    end
  end
  for i, segment in ipairs(arena_demo_snake.segments) do
    local x, y = segment.x*sx, segment.y*sy
    if i == 1 then
      draw_screen_box(x, y, 22, 22, 0.2, 0.95, 0.45)
      love.graphics.setColor(0.95, 0.95, 0.75, 1)
      love.graphics.line(x, y, x + 22*math.cos(segment.r), y + 22*math.sin(segment.r))
    else
      draw_screen_box(x, y, 20, 20, 0.35, 0.65, 0.95)
    end
  end
  return true
end

local function draw_arena_demo_targets(arena)
  if #arena_demo_targets == 0 then reset_arena_demo_targets() end
  local t = time or 0
  for i, target in ipairs(arena_demo_targets) do
    local pulse = 1 + 0.18*math.sin(t*5 + (target.phase or i))
    local x, y = target.x*sx, target.y*sy
    draw_screen_box(x, y, 24*pulse, 24*pulse, 0.95, 0.22, 0.18)
    love.graphics.setColor(1, 0.62, 0.42, 1)
    love.graphics.rectangle('line', math.floor(x - 16), math.floor(y - 16), 32, 32)
    love.graphics.line(x - 14, y, x + 14, y)
    love.graphics.line(x, y - 14, x, y + 14)
  end

  if arena_demo_shot then
    love.graphics.setColor(1, 0.88, 0.32, 1)
    love.graphics.line(arena_demo_shot.x1*sx, arena_demo_shot.y1*sy, arena_demo_shot.x2*sx, arena_demo_shot.y2*sy)
  end
  for _, burst in ipairs(arena_demo_bursts) do
    local size = 12 + 34*(burst.t/0.45)
    draw_screen_box(burst.x*sx, burst.y*sy, size, size, 0.96, 0.82, 0.24)
  end

  local x1, y1 = (arena.x1 or 0) + 12, (arena.y1 or 0) + 12
  love.graphics.setColor(0.82, 0.94, 0.72, 1)
  love.graphics.print('hits ' .. tostring(arena_demo_score), math.floor(x1*sx), math.floor(y1*sy))
  if arena_demo_hit_flash > 0 then
    if arena_demo_hit_x and arena_demo_hit_y then
      local s = 18 + 24*(arena_demo_hit_flash/0.8)
      draw_screen_box(arena_demo_hit_x*sx, arena_demo_hit_y*sy, s, s, 0.96, 0.82, 0.24)
    end
    love.graphics.setColor(0.96, 0.88, 0.32, 1)
    love.graphics.print('+1', math.floor((gw/2 + 22)*sx), math.floor((gh/2 - 22)*sy))
  end
end

local function draw_arena_actor_overlay()
  if not is_current_arena() then return end
  local arena = main.current
  if not arena.main or not arena.main.objects then return end

  if arena_demo_frames > 180 then
    draw_arena_demo_background(arena)
    if not draw_arena_demo_snake() then
      local t = time or 0
      local cx, cy = gw*sx/2, gh*sy/2
      for i = 1, 3 do
        local a = t*1.8 - i*0.55
        draw_screen_box(cx + 34*i*math.cos(a), cy + 24*i*math.sin(a), 16, 16,
          i == 1 and 0.2 or 0.35, i == 1 and 0.95 or 0.65, i == 1 and 0.45 or 0.95)
      end
    end
    draw_arena_demo_targets(arena)
    love.graphics.setColor(1, 1, 1, 1)
    return
  end

  local x1, y1 = (arena.x1 or 0) + 12, (arena.y1 or 0) + 12
  local x2, y2 = (arena.x2 or gw) - 12, (arena.y2 or gh) - 12
  local players_drawn, enemies_drawn = 0, 0

  for _, object in ipairs(arena.main.objects) do
    local is_player = Player and object.is and object:is(Player)
    local is_seeker = Seeker and object.is and object:is(Seeker)
    local is_critter = EnemyCritter and object.is and object:is(EnemyCritter)
    if (is_player or is_seeker or is_critter) and not object.dead then
      local x, y = arena_object_position(object)
      if x and y then
        x = clamp_value(x, x1, x2)*sx
        y = clamp_value(y, y1, y2)*sy
        local size = ((object.shape and (object.shape.w or object.shape.rs)) or 7)*sx
        if is_player then
          local r, g, b = object.leader and 0.2 or 0.25, object.leader and 0.95 or 0.65, object.leader and 0.45 or 0.95
          draw_screen_box(x, y, math.max(12, size), math.max(12, size), r, g, b)
          if object.r then
            love.graphics.setColor(0.95, 0.95, 0.75, 1)
            love.graphics.line(x, y, x + 15*math.cos(object.r), y + 15*math.sin(object.r))
          end
          players_drawn = players_drawn + 1
        elseif is_seeker then
          draw_screen_box(x, y, math.max(10, size), math.max(10, size), 0.95, 0.25, 0.2)
          enemies_drawn = enemies_drawn + 1
        elseif is_critter then
          draw_screen_box(x, y, 7, 7, 0.75, 0.35, 1)
          enemies_drawn = enemies_drawn + 1
        end
      end
    end
  end

  if players_drawn == 0 then
    local t = time or 0
    local cx, cy = gw*sx/2, gh*sy/2
    for i = 1, 3 do
      local a = t*1.8 - i*0.55
      draw_screen_box(cx + 34*i*math.cos(a), cy + 24*i*math.sin(a), 16, 16,
        i == 1 and 0.2 or 0.35, i == 1 and 0.95 or 0.65, i == 1 and 0.45 or 0.95)
    end
  end
  if enemies_drawn == 0 then
    local t = time or 0
    local cx, cy = gw*sx/2, gh*sy/2
    for i = 1, 5 do
      local a = t*0.9 + i*1.256
      draw_screen_box(cx + 170*math.cos(a), cy + 86*math.sin(a), 10, 10, 0.95, 0.25, 0.2)
    end
  end
  love.graphics.setColor(1, 1, 1, 1)
end

local function init_engine_callbacks()
  state = state or {}
  state.no_screen_movement = true
  state.mouse_control = true
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
  love.mouse.setVisible(true)
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
    if is_current_arena() then
      arena_demo_frames = arena_demo_frames + 1
      if arena_demo_frames == 1 then reset_arena_demo_targets() end
    else
      arena_demo_frames = 0
      arena_demo_targets = {}
      arena_demo_score = 0
      arena_demo_hit_flash = 0
      arena_demo_hit_x, arena_demo_hit_y = nil, nil
      arena_demo_snake = nil
      arena_demo_attack_timer = 0
      arena_demo_bursts = {}
      arena_demo_shot = nil
    end
    if is_current_arena() and arena_demo_frames > 180 then
      if camera then camera.x, camera.y, camera.r = gw/2, gh/2, 0 end
      update_arena_demo_motion(fixed_dt)
    else
      update(fixed_dt)
    end
    keep_arena_visible()
    system.update()
    sync_mouse_visibility()
    clear_stuck_arena_transition()
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
  if main and not (is_current_arena() and arena_demo_frames > 180) then draw() end
  draw_arena_actor_overlay()
end

function love.keypressed(key)
  if main and main.current and MainMenu and main.current.is and main.current:is(MainMenu)
      and (key == 'return' or key == 'space')
      and main.current.arena_run_button and main.current.arena_run_button.action then
    main.current.arena_run_button:action()
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
