local W, H
local fonts = {}
local screen = "menu"
local selected = 1
local games = {}
local active = nil

local palette = {
  bg = {0.035, 0.045, 0.055},
  panel = {0.075, 0.095, 0.12},
  panelHot = {0.12, 0.16, 0.2},
  ink = {0.92, 0.96, 0.95},
  dim = {0.48, 0.58, 0.62},
  cyan = {0.20, 0.78, 0.92},
  yellow = {0.95, 0.78, 0.22},
  red = {0.95, 0.24, 0.20},
  green = {0.28, 0.86, 0.45},
  violet = {0.72, 0.52, 0.95},
}

local function color(c, a)
  love.graphics.setColor(c[1], c[2], c[3], a or c[4] or 1)
end

local function rect(mode, x, y, w, h, c)
  color(c)
  love.graphics.rectangle(mode, x, y, w, h)
end

local function text(font, s, x, y, c)
  love.graphics.setFont(font)
  color(c)
  love.graphics.print(s, x, y)
end

local function clamp(v, lo, hi)
  if v < lo then return lo end
  if v > hi then return hi end
  return v
end

local function wrap(v, max)
  if v < 0 then return v + max end
  if v >= max then return v - max end
  return v
end

local function dist2(ax, ay, bx, by)
  local dx, dy = ax - bx, ay - by
  return dx * dx + dy * dy
end

local function goMenu()
  screen = "menu"
  active = nil
  love.mouse.setVisible(true)
end

local function startGame(i)
  selected = i
  active = games[i]
  active.reset()
  screen = "game"
  love.mouse.setVisible(false)
end

local function drawHeader(title, hint)
  text(fonts.small, "ESC returns to the gallery", 28, 18, palette.dim)
  text(fonts.title, title, 28, 46, palette.ink)
  text(fonts.body, hint, 32, 100, palette.dim)
end

local pong = {}
function pong.reset()
  pong.py = H / 2 - 52
  pong.ai = pong.py
  pong.bx, pong.by = W / 2, H / 2
  pong.bvx, pong.bvy = 360, 175
  pong.ps, pong.as = 0, 0
end
function pong.update(dt)
  local speed = 430
  if love.keyboard.isDown("w") or love.keyboard.isDown("up") then pong.py = pong.py - speed * dt end
  if love.keyboard.isDown("s") or love.keyboard.isDown("down") then pong.py = pong.py + speed * dt end
  pong.py = clamp(pong.py, 128, H - 128)
  pong.ai = pong.ai + clamp(pong.by - (pong.ai + 52), -260 * dt, 260 * dt)
  pong.ai = clamp(pong.ai, 128, H - 128)
  pong.bx = pong.bx + pong.bvx * dt
  pong.by = pong.by + pong.bvy * dt
  if pong.by < 128 or pong.by > H - 34 then pong.bvy = -pong.bvy end
  if pong.bx < 76 and pong.by > pong.py and pong.by < pong.py + 104 then
    pong.bx = 76
    pong.bvx = math.abs(pong.bvx) + 16
    pong.bvy = (pong.by - (pong.py + 52)) * 5
  end
  if pong.bx > W - 76 and pong.by > pong.ai and pong.by < pong.ai + 104 then
    pong.bx = W - 76
    pong.bvx = -math.abs(pong.bvx) - 16
    pong.bvy = (pong.by - (pong.ai + 52)) * 5
  end
  if pong.bx < 0 then pong.as = pong.as + 1; pong.reset(); pong.bvx = -360 end
  if pong.bx > W then pong.ps = pong.ps + 1; pong.reset() end
end
function pong.draw()
  drawHeader("PONG", "W/S or Up/Down move the left paddle.")
  love.graphics.setLineWidth(2)
  color(palette.dim, 0.45)
  for y = 136, H - 36, 32 do love.graphics.line(W / 2, y, W / 2, y + 14) end
  rect("fill", 56, pong.py, 14, 104, palette.cyan)
  rect("fill", W - 70, pong.ai, 14, 104, palette.yellow)
  color(palette.ink)
  love.graphics.circle("fill", pong.bx, pong.by, 10)
  text(fonts.big, tostring(pong.ps), W / 2 - 90, 142, palette.cyan)
  text(fonts.big, tostring(pong.as), W / 2 + 54, 142, palette.yellow)
end

local snake = {}
function snake.reset()
  snake.cell = 20
  snake.cols, snake.rows = 32, 18
  snake.ox = math.floor((W - snake.cols * snake.cell) / 2)
  snake.oy = 136
  snake.dir, snake.nextDir = "right", "right"
  snake.body = {{8, 9}, {7, 9}, {6, 9}}
  snake.food = {22, 9}
  snake.timer = 0
  snake.score = 0
  snake.dead = false
end
local function snakeFood()
  snake.food = {math.random(1, snake.cols), math.random(1, snake.rows)}
end
function snake.update(dt)
  if snake.dead then return end
  snake.timer = snake.timer + dt
  if snake.timer < 0.105 then return end
  snake.timer = 0
  snake.dir = snake.nextDir
  local head = snake.body[1]
  local nx, ny = head[1], head[2]
  if snake.dir == "left" then nx = nx - 1 elseif snake.dir == "right" then nx = nx + 1
  elseif snake.dir == "up" then ny = ny - 1 else ny = ny + 1 end
  if nx < 1 or nx > snake.cols or ny < 1 or ny > snake.rows then snake.dead = true; return end
  for _, p in ipairs(snake.body) do if p[1] == nx and p[2] == ny then snake.dead = true; return end end
  table.insert(snake.body, 1, {nx, ny})
  if nx == snake.food[1] and ny == snake.food[2] then
    snake.score = snake.score + 1
    snakeFood()
  else
    table.remove(snake.body)
  end
end
function snake.keypressed(k)
  if k == "left" and snake.dir ~= "right" then snake.nextDir = "left" end
  if k == "right" and snake.dir ~= "left" then snake.nextDir = "right" end
  if k == "up" and snake.dir ~= "down" then snake.nextDir = "up" end
  if k == "down" and snake.dir ~= "up" then snake.nextDir = "down" end
  if (k == "return" or k == "space") and snake.dead then snake.reset() end
end
function snake.draw()
  drawHeader("SNAKE", "Arrow keys steer. Eat the yellow squares.")
  rect("fill", snake.ox - 8, snake.oy - 8, snake.cols * snake.cell + 16, snake.rows * snake.cell + 16, palette.panel)
  rect("fill", snake.ox + (snake.food[1] - 1) * snake.cell + 3, snake.oy + (snake.food[2] - 1) * snake.cell + 3, 14, 14, palette.yellow)
  for i, p in ipairs(snake.body) do
    rect("fill", snake.ox + (p[1] - 1) * snake.cell + 2, snake.oy + (p[2] - 1) * snake.cell + 2, 16, 16, i == 1 and palette.cyan or palette.green)
  end
  text(fonts.body, "Score " .. snake.score, snake.ox, snake.oy + snake.rows * snake.cell + 22, palette.ink)
  if snake.dead then text(fonts.body, "Crash. Press Enter to restart.", snake.ox + 210, snake.oy + 170, palette.red) end
end

local breakout = {}
function breakout.reset()
  breakout.px = W / 2 - 70
  breakout.bx, breakout.by = W / 2, H - 150
  breakout.bvx, breakout.bvy = 270, -320
  breakout.lastMouseX = love.mouse.getX()
  breakout.bricks = {}
  for r = 1, 5 do
    for c = 1, 10 do table.insert(breakout.bricks, {x = 110 + (c - 1) * 76, y = 130 + r * 26, alive = true, row = r}) end
  end
end
function breakout.update(dt)
  local mx = love.mouse.getX()
  if mx ~= breakout.lastMouseX then
    breakout.px = clamp(mx - 70, 52, W - 192)
    breakout.lastMouseX = mx
  end
  if love.keyboard.isDown("left") then breakout.px = breakout.px - 460 * dt end
  if love.keyboard.isDown("right") then breakout.px = breakout.px + 460 * dt end
  breakout.px = clamp(breakout.px, 52, W - 192)
  breakout.bx = breakout.bx + breakout.bvx * dt
  breakout.by = breakout.by + breakout.bvy * dt
  if breakout.bx < 42 or breakout.bx > W - 42 then breakout.bvx = -breakout.bvx end
  if breakout.by < 126 then breakout.bvy = math.abs(breakout.bvy) end
  if breakout.by > H - 88 and breakout.by < H - 58 and breakout.bx > breakout.px and breakout.bx < breakout.px + 140 then
    breakout.bvy = -math.abs(breakout.bvy)
    breakout.bvx = (breakout.bx - (breakout.px + 70)) * 5
  end
  for _, b in ipairs(breakout.bricks) do
    if b.alive and breakout.bx > b.x and breakout.bx < b.x + 62 and breakout.by > b.y and breakout.by < b.y + 18 then
      b.alive = false
      breakout.bvy = -breakout.bvy
      break
    end
  end
  if breakout.by > H + 30 then breakout.reset() end
end
function breakout.draw()
  drawHeader("BREAKOUT", "Mouse or Left/Right moves the paddle.")
  for _, b in ipairs(breakout.bricks) do
    if b.alive then rect("fill", b.x, b.y, 62, 18, ({palette.red, palette.yellow, palette.green, palette.cyan, palette.violet})[b.row]) end
  end
  rect("fill", breakout.px, H - 74, 140, 16, palette.ink)
  color(palette.yellow)
  love.graphics.circle("fill", breakout.bx, breakout.by, 9)
end

local ast = {}
function ast.reset()
  ast.x, ast.y, ast.a, ast.vx, ast.vy = W / 2, H / 2 + 30, -math.pi / 2, 0, 0
  ast.cool = 0
  ast.bullets = {}
  ast.rocks = {}
  for i = 1, 8 do table.insert(ast.rocks, {x = math.random(60, W - 60), y = math.random(145, H - 60), vx = math.random(-70, 70), vy = math.random(-60, 60), r = math.random(18, 34)}) end
end
function ast.update(dt)
  if love.keyboard.isDown("left") then ast.a = ast.a - 4.2 * dt end
  if love.keyboard.isDown("right") then ast.a = ast.a + 4.2 * dt end
  if love.keyboard.isDown("up") then ast.vx = ast.vx + math.cos(ast.a) * 220 * dt; ast.vy = ast.vy + math.sin(ast.a) * 220 * dt end
  ast.x = wrap(ast.x + ast.vx * dt, W)
  ast.y = wrap(ast.y + ast.vy * dt, H)
  if ast.y < 122 then ast.y = H - 20 end
  ast.vx, ast.vy = ast.vx * 0.995, ast.vy * 0.995
  ast.cool = ast.cool - dt
  if love.keyboard.isDown("space") and ast.cool <= 0 then
    ast.cool = 0.18
    table.insert(ast.bullets, {x = ast.x, y = ast.y, vx = math.cos(ast.a) * 520, vy = math.sin(ast.a) * 520, life = 1.1})
  end
  for i = #ast.bullets, 1, -1 do
    local b = ast.bullets[i]
    b.x, b.y, b.life = wrap(b.x + b.vx * dt, W), wrap(b.y + b.vy * dt, H), b.life - dt
    if b.life <= 0 then table.remove(ast.bullets, i) end
  end
  for _, r in ipairs(ast.rocks) do r.x = wrap(r.x + r.vx * dt, W); r.y = wrap(r.y + r.vy * dt, H) end
  for ri = #ast.rocks, 1, -1 do
    local r = ast.rocks[ri]
    for bi = #ast.bullets, 1, -1 do
      local b = ast.bullets[bi]
      if dist2(r.x, r.y, b.x, b.y) < r.r * r.r then table.remove(ast.rocks, ri); table.remove(ast.bullets, bi); break end
    end
  end
  if #ast.rocks == 0 then ast.reset() end
end
function ast.draw()
  drawHeader("ASTEROIDS", "Left/Right rotate, Up thrusts, Space fires.")
  color(palette.cyan)
  local x1, y1 = ast.x + math.cos(ast.a) * 22, ast.y + math.sin(ast.a) * 22
  local x2, y2 = ast.x + math.cos(ast.a + 2.45) * 18, ast.y + math.sin(ast.a + 2.45) * 18
  local x3, y3 = ast.x + math.cos(ast.a - 2.45) * 18, ast.y + math.sin(ast.a - 2.45) * 18
  love.graphics.polygon("line", x1, y1, x2, y2, x3, y3)
  color(palette.yellow)
  for _, b in ipairs(ast.bullets) do love.graphics.circle("fill", b.x, b.y, 3) end
  love.graphics.setLineWidth(2)
  color(palette.ink)
  for _, r in ipairs(ast.rocks) do love.graphics.circle("line", r.x, r.y, r.r, 12) end
end

games = {
  {title = "Pong", subtitle = "A paddle duel with a simple AI opponent.", reset = pong.reset, update = pong.update, draw = pong.draw},
  {title = "Snake", subtitle = "Classic grid movement and tail collision.", reset = snake.reset, update = snake.update, draw = snake.draw, keypressed = snake.keypressed},
  {title = "Breakout", subtitle = "Mouse paddle, bricks, and ball physics.", reset = breakout.reset, update = breakout.update, draw = breakout.draw},
  {title = "Asteroids", subtitle = "Thrust, wraparound, bullets, and rocks.", reset = ast.reset, update = ast.update, draw = ast.draw},
}

function love.load()
  W, H = love.graphics.getWidth(), love.graphics.getHeight()
  fonts.title = love.graphics.newFont(36)
  fonts.big = love.graphics.newFont(32)
  fonts.body = love.graphics.newFont(20)
  fonts.small = love.graphics.newFont(14)
  love.graphics.setBackgroundColor(palette.bg)
  love.mouse.setVisible(true)
  math.randomseed(os.time())
end

function love.update(dt)
  if screen == "game" and active and active.update then active.update(dt) end
end

local function drawMenu()
  text(fonts.title, "LOVE GAME GALLERY", 42, 34, palette.ink)
  text(fonts.body, "Native wasm32posix runtime rendering through KMS/EGL/GLES", 48, 88, palette.dim)
  text(fonts.small, "Arrow keys select, Enter starts, mouse click starts", 50, 122, palette.dim)
  local x, y, w, h = 72, 172, W - 144, 72
  for i, g in ipairs(games) do
    local hot = i == selected
    rect("fill", x, y + (i - 1) * 88, w, h, hot and palette.panelHot or palette.panel)
    rect("line", x, y + (i - 1) * 88, w, h, hot and palette.cyan or palette.dim)
    text(fonts.big, tostring(i), x + 22, y + (i - 1) * 88 + 18, hot and palette.yellow or palette.dim)
    text(fonts.body, g.title, x + 82, y + (i - 1) * 88 + 14, palette.ink)
    text(fonts.small, g.subtitle, x + 82, y + (i - 1) * 88 + 44, palette.dim)
  end
end

function love.draw()
  love.graphics.setLineWidth(1)
  if screen == "menu" then
    drawMenu()
  elseif active then
    active.draw()
  end
end

function love.keypressed(k)
  if screen == "menu" then
    if k == "down" then selected = selected % #games + 1 end
    if k == "up" then selected = (selected - 2) % #games + 1 end
    if k == "return" or k == "space" then startGame(selected) end
    if k == "1" or k == "2" or k == "3" or k == "4" then startGame(tonumber(k)) end
  else
    if k == "escape" or k == "backspace" then goMenu(); return end
    if active and active.keypressed then active.keypressed(k) end
  end
end

function love.mousepressed(x, y, button)
  if screen ~= "menu" or button ~= 1 then return end
  for i = 1, #games do
    local yy = 172 + (i - 1) * 88
    if x >= 72 and x <= W - 72 and y >= yy and y <= yy + 72 then
      startGame(i)
      return
    end
  end
end

function love.mousemoved(x, y)
  if screen ~= "menu" then return end
  for i = 1, #games do
    local yy = 172 + (i - 1) * 88
    if x >= 72 and x <= W - 72 and y >= yy and y <= yy + 72 then selected = i end
  end
end
