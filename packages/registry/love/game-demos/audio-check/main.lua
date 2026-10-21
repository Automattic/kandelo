-- Run after rebuilding with:
-- love /usr/share/love/examples/audio-check
-- Assertions exercise the same Lua API, decoder, SDL callback and /dev/dsp
-- path as the games. Browser playback requires user activation.
local function near(a, b, tolerance)
  assert(math.abs(a - b) <= tolerance, tostring(a) .. " differs from " .. tostring(b))
end

local function waitFor(predicate)
  local deadline = love.timer.getTime() + 10
  repeat
    if predicate() then return end
    love.timer.sleep(0.005)
  until love.timer.getTime() >= deadline
  error("audio callback did not reach the expected state")
end

function love.run()
  assert(love.graphics == nil and love.window == nil)
  local root = love.filesystem.getSource() .. "/.."
  local original = love.audio.newSource(root .. "/sounds/score.wav", "static")
  local source = original:clone()
  near(source:getDuration(), 0.2, 0.001)
  assert(source:getChannelCount() == 1 and source:getType() == "static")
  assert(source:isStopped() and not source:isPlaying())
  source:setVolume(0.25)
  source:setPitch(0.5)
  source:setLooping(true)
  assert(source:play())
  waitFor(function() return source:tell() > 0.01 end)
  local beforePlay = source:tell()
  assert(source:play()) -- Playing an active source must not restart it.
  source:pause()
  assert(source:tell() >= beforePlay)
  assert(not source:isPlaying() and not source:isStopped())
  local paused = source:tell("samples")
  love.timer.sleep(0.04)
  near(source:tell("samples"), paused, 0)
  source:seek(0.15)
  assert(source:play()) -- Resume must preserve the explicit seek.
  source:pause()
  assert(source:tell() >= 0.15)
  source:stop()
  near(source:tell(), 0, 0)
  near(original:getVolume(), 1, 0)
  near(original:getPitch(), 1, 0)
  assert(not original:isLooping()) -- Clone properties are independent.

  local a, b = original:clone(), original:clone()
  a:setLooping(true)
  b:setLooping(true)
  assert(love.audio.play({a, b}))
  local pausedSources = love.audio.pause()
  assert(#pausedSources == 2 and love.audio.getActiveSourceCount() == 0)
  assert(love.audio.play(pausedSources))
  assert(love.audio.getActiveSourceCount() == 2)
  love.audio.stop(a)
  assert(a:isStopped() and b:isPlaying())
  love.audio.stop()
  assert(b:isStopped())

  -- Dropping Lua's last reference must not cut an active voice short.
  local ephemeral = original:clone()
  ephemeral:setLooping(true)
  assert(ephemeral:play())
  ephemeral = nil
  collectgarbage("collect")
  assert(love.audio.getActiveSourceCount() == 1)
  love.audio.stop()

  -- Both eager and streamed Vorbis use the real upstream game asset.
  local ogg = root .. "/bytepath/resources/sounds/keystroke_1.ogg"
  local decoded = love.audio.newSource(ogg, "static")
  local stream = love.audio.newSource(ogg, "stream")
  near(decoded:getDuration("samples"), stream:getDuration("samples"), 0)
  assert(stream:getType() == "stream")
  stream:setPitch(0.5)
  stream:setLooping(true)
  stream:seek(math.max(0, stream:getDuration("samples") - 4), "samples")
  assert(stream:play())
  love.timer.sleep(0.1) -- Cross EOF and refill the decoder at fractional pitch.
  assert(stream:isPlaying())
  local streamClone = stream:clone()
  assert(streamClone:isStopped() and streamClone:isLooping())
  stream:stop()
  streamClone:setLooping(false)
  streamClone:setPitch(2)
  assert(streamClone:play())
  waitFor(function() return streamClone:isStopped() end)
  assert(not pcall(love.audio.newSource, root .. "/missing.ogg", "static"))
  assert(not pcall(source.setPitch, source, 0))
  assert(not love.audio.isEffectsSupported())
  assert(not source:setEffect("reverb"))
  assert(not pcall(source.setPosition, source, 1, 0, 0))
  source:release()
  assert(not pcall(source.play, source))
  love.audio.stop()
  print("love: audio API checks passed")
  return function() return 0 end
end
