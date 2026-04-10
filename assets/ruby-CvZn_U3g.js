import{B as L,k as A}from"./browser-kernel-DeZfH_RD.js";/* empty css               */import{P as U}from"./xterm-CyPUMFhC.js";const M="/wasm-posix-kernel/assets/ruby-DKN__EPu.wasm",_=document.getElementById("terminal"),h=document.getElementById("start"),b=document.getElementById("stop"),f=document.getElementById("snippets"),B=document.getElementById("code"),p=document.getElementById("batch-output"),g=document.getElementById("run"),y=document.getElementById("examples"),m=document.getElementById("status"),w=document.getElementById("mode-interactive"),v=document.getElementById("mode-batch"),I=document.getElementById("interactive-view"),S=document.getElementById("batch-view"),R=new TextDecoder,C=new TextEncoder;w.addEventListener("click",()=>{w.classList.add("active"),v.classList.remove("active"),I.classList.remove("hidden"),S.classList.add("hidden")});v.addEventListener("click",()=>{v.classList.add("active"),w.classList.remove("active"),S.classList.remove("hidden"),I.classList.add("hidden")});function u(e,t){m.style.display="block",m.textContent=e,m.className=`status ${t}`}function T(){m.style.display="none"}let l=null,c=null;async function P(){if(l&&c)return"";u("Loading kernel + Ruby (~4MB)...","loading");const e=await Promise.all([fetch(A).then(t=>t.arrayBuffer()),fetch(M).then(t=>t.arrayBuffer())]);return l=e[0],c=e[1],[`Kernel: ${(l.byteLength/1024).toFixed(0)}KB`,`Ruby: ${(c.byteLength/(1024*1024)).toFixed(1)}MB`].join(", ")+`
`}const q=["HOME=/home","TMPDIR=/tmp","TERM=xterm-256color","LANG=en_US.UTF-8","PATH=/usr/local/bin:/usr/bin:/bin"],$=`
$stdout.sync = true
$stderr.sync = true
puts "Ruby #{RUBY_VERSION} REPL (eval loop)"
puts "Type 'exit' to quit."
puts
binding_ctx = binding
loop do
  print "ruby> "
  line = gets
  break unless line
  line.chomp!
  break if line == 'exit' || line == 'quit'
  next if line.empty?
  begin
    result = eval(line, binding_ctx)
    puts "=> #{result.inspect}"
  rescue Exception => e
    $stderr.puts "#{e.class}: #{e.message}"
  end
end
puts
`;function H(e,t,s){const n=C.encode(s),r=e.open(t,577,493);e.write(r,n,null,n.length),e.close(r)}let E=null,a=null;async function O(){h.disabled=!0,b.disabled=!1,_.innerHTML="";try{const e=await P(),t=new L;await t.init(l);const s=t.fs;for(const d of["/tmp","/home","/usr","/usr/bin"])try{s.mkdir(d,493)}catch{}H(s,"/tmp/repl.rb",$),E=t;const n=new U(_,t);a=n,e&&n.terminal.writeln(e.trimEnd()),u("Starting Ruby REPL...","running"),T(),n.terminal.focus();const r=await n.spawn(c,["ruby","/tmp/repl.rb"],{env:q});n.terminal.writeln(`\r
[Ruby exited with code ${r}]`)}catch(e){a&&a.terminal.writeln(`\r
Error: ${e}`),u(`Error: ${e}`,"error"),console.error(e)}finally{E=null,h.disabled=!1,b.disabled=!0}}function Y(){a&&(a.terminal.writeln(`\r
[Ruby stopped]`),a.dispose(),a=null),E=null,h.disabled=!1,b.disabled=!0}h.addEventListener("click",O);b.addEventListener("click",Y);f.addEventListener("change",()=>{const e={hello:'puts "Hello, World!"',version:"puts RUBY_VERSION",array:"[1,2,3,4,5].map { |x| x ** 2 }",hash:'{a: 1, b: 2}.each { |k,v| puts "#{k}=#{v}" }',block:'3.times { |i| puts "iteration #{i}" }'},t=f.value;t&&e[t]&&a&&a.write(e[t]+`
`),f.value=""});const x={hello:`puts "Hello from Ruby #{RUBY_VERSION} on WebAssembly!"
puts
puts "Config:"
puts "  RUBY_PLATFORM = #{RUBY_PLATFORM}"
puts "  RUBY_VERSION  = #{RUBY_VERSION}"
puts "  RUBY_ENGINE   = #{RUBY_ENGINE}"

features = %w[blocks iterators mixins closures symbols regex]
puts
puts "Ruby features available:"
features.each { |f| puts "  - #{f}" }
`,blocks:`# Blocks, Procs, and Lambdas

# Block with each
puts "Counting:"
(1..5).each { |n| puts "  #{n}" }

# Block with map and select
squares = (1..10).map { |n| n ** 2 }
evens = squares.select(&:even?)
puts "\\nSquares: #{squares.join(', ')}"
puts "Even squares: #{evens.join(', ')}"

# Yielding to blocks
def repeat(n)
  n.times { |i| yield i }
end

puts "\\nRepeating:"
repeat(3) { |i| puts "  iteration #{i}" }

# Proc and Lambda
doubler = Proc.new { |x| x * 2 }
tripler = ->(x) { x * 3 }
puts "\\ndouble(5) = #{doubler.call(5)}"
puts "triple(5) = #{tripler.call(5)}"

# Method chaining
result = (1..20)
  .select { |n| n % 3 == 0 }
  .map { |n| n ** 2 }
  .reduce(:+)
puts "\\nSum of squares of multiples of 3 (1..20): #{result}"
`,hash:`# Hashes and data structures

students = {
  math:    %w[Alice Bob Charlie],
  science: %w[Bob Diana Eve],
  english: %w[Alice Charlie Eve Frank],
}

puts "Class rosters:"
students.sort.each do |course, names|
  puts "  #{course}: #{names.join(', ')}"
end

# Count appearances
counts = Hash.new(0)
students.each_value do |names|
  names.each { |name| counts[name] += 1 }
end

puts "\\nStudent course counts:"
counts.sort_by { |name, count| [-count, name] }.each do |name, count|
  puts "  #{name}: #{count} courses"
end

# Students in multiple classes
multi = counts.select { |_, c| c > 1 }.keys.sort
puts "\\nStudents in multiple classes: #{multi.join(', ')}"

# Nested hash with default
graph = Hash.new { |h, k| h[k] = [] }
[[1,2], [1,3], [2,4], [3,4], [4,5]].each do |a, b|
  graph[a] << b
  graph[b] << a
end
puts "\\nAdjacency list:"
graph.sort.each { |node, neighbors| puts "  #{node}: #{neighbors}" }
`,file:`# File I/O

path = "/tmp/ruby-demo.txt"

# Write a file
File.open(path, "w") do |f|
  (1..10).each do |i|
    f.puts format("Line %02d: %s", i, "x" * (i * 3))
  end
end
puts "Wrote #{path}"

# Read it back
lines = File.readlines(path, chomp: true)
puts "Read #{lines.size} lines"

# Process: show longest lines
sorted = lines.sort_by { |l| -l.length }
puts "\\nTop 3 longest lines:"
sorted.first(3).each do |line|
  puts format("  [%2d chars] %s", line.length, line)
end

# Stats
total_chars = lines.sum(&:length)
puts format("\\nTotal characters: %d", total_chars)
puts format("Average line length: %.1f", total_chars.to_f / lines.size)
`,functional:`# Enumerable methods — Ruby's functional programming toolkit

numbers = (1..20).to_a

# map: transform
squares = numbers.map { |n| n ** 2 }
puts "Squares: #{squares.join(', ')}"

# select: filter
evens = numbers.select(&:even?)
puts "Evens: #{evens.join(', ')}"

# Chained: even squares
even_sq = numbers.map { |n| n ** 2 }.select(&:even?)
puts "Even squares: #{even_sq.join(', ')}"

# sort with custom comparator
words = %w[banana apple cherry date elderberry fig grape]
by_length = words.sort_by { |w| [w.length, w] }
puts "\\nSorted by length: #{by_length.join(', ')}"

# reduce (inject)
product = (1..10).reduce(:*)
puts "\\n10! = #{product}"
puts "Sum 1..20 = #{numbers.reduce(:+)}"
puts "Max = #{numbers.max}, Min = #{numbers.min}"

# group_by
grouped = words.group_by { |w| w.length }
puts "\\nGrouped by length:"
grouped.sort.each { |len, ws| puts "  #{len} chars: #{ws.join(', ')}" }

# each_with_object (like fold/accumulate)
freq = "hello world".chars.each_with_object(Hash.new(0)) { |c, h| h[c] += 1 }
puts "\\nCharacter frequencies:"
freq.sort_by { |_, v| -v }.each { |c, n| puts "  '#{c}': #{n}" }
`,oop:`# Classes, inheritance, modules

module Speakable
  def speak
    "#{name} says #{sound}!"
  end
end

class Animal
  include Speakable
  attr_reader :name, :sound

  def initialize(name:, sound: "...")
    @name = name
    @sound = sound
  end

  def to_s
    "#{self.class}(#{name})"
  end
end

class Dog < Animal
  def initialize(name:)
    super(name: name, sound: "Woof")
  end

  def fetch(item)
    "#{name} fetches the #{item}!"
  end
end

class Cat < Animal
  def initialize(name:)
    super(name: name, sound: "Meow")
  end

  def purr
    "#{name} purrs..."
  end
end

pets = [
  Dog.new(name: "Rex"),
  Cat.new(name: "Whiskers"),
  Dog.new(name: "Buddy"),
  Cat.new(name: "Luna"),
]

pets.each { |pet| puts pet.speak }

puts
puts pets[0].fetch("ball")
puts pets[1].purr

puts "\\nAll animals:"
pets.each { |pet| puts "  #{pet.name} is a #{pet.class}" }

# Comparable mixin
class Temperature
  include Comparable
  attr_reader :degrees

  def initialize(degrees)
    @degrees = degrees
  end

  def <=>(other)
    degrees <=> other.degrees
  end

  def to_s
    "#{degrees}°"
  end
end

temps = [72, 65, 80, 55, 90].map { |d| Temperature.new(d) }
puts "\\nTemperatures sorted: #{temps.sort.join(', ')}"
puts "Hottest: #{temps.max}, Coldest: #{temps.min}"
`};function i(e,t){const s=document.createElement("span");t&&(s.className=t),s.textContent=e,p.appendChild(s),p.scrollTop=p.scrollHeight}async function j(){g.disabled=!0,p.textContent="";try{const e=await P();e&&i(e,"info");const t=B.value,s=new L({onStdout:o=>i(R.decode(o)),onStderr:o=>i(R.decode(o),"stderr")});await s.init(l);const n=s.fs;for(const o of["/tmp","/home"])try{n.mkdir(o,493)}catch{}const r="/tmp/script.rb",d=C.encode(t),k=n.open(r,577,420);n.write(k,d,null,d.length),n.close(k),u("Running Ruby...","running");const N=await s.spawn(c,["ruby",r],{env:q});i(`
Exited with code ${N}
`,"info"),T()}catch(e){i(`
Error: ${e}
`,"stderr"),u(`Error: ${e}`,"error"),console.error(e)}finally{g.disabled=!1}}g.addEventListener("click",j);y.addEventListener("change",()=>{const e=y.value;e&&x[e]&&(B.value=x[e]),y.value=""});B.addEventListener("keydown",e=>{(e.ctrlKey||e.metaKey)&&e.key==="Enter"&&(e.preventDefault(),j())});
