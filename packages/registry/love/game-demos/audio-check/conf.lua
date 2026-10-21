-- Standard LÖVE headless configuration; the audio path is identical on
-- browser and Node hosts and does not require a graphics context.
function love.conf(t)
  t.window = false
  t.modules.graphics = false
  t.modules.window = false
end
