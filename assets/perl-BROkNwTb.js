import{k as O,B as H}from"./browser-kernel-DS31Lu-o.js";/* empty css               */import{P as U}from"./xterm-CyPUMFhC.js";const f="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";function V(e){const t=e.endsWith("==")?2:e.endsWith("=")?1:0,n=new Uint8Array(e.length*3/4-t);let r=0;for(let s=0;s<e.length;s+=4){const l=f.indexOf(e[s]),u=f.indexOf(e[s+1]),i=f.indexOf(e[s+2]),a=f.indexOf(e[s+3]),d=l<<18|u<<12|Math.max(0,i)<<6|Math.max(0,a);n[r++]=d>>16&255,r<n.length&&(n[r++]=d>>8&255),r<n.length&&(n[r++]=d&255)}return n}async function F(e,t,n){const r=await fetch(t);if(!r.ok)throw new Error(`Failed to load Perl stdlib bundle from ${t} (${r.status}). Run: bash examples/browser/scripts/build-perl-bundle.sh`);const s=await r.json(),l=new Set;function u(a){if(l.has(a)||a==="/"||a==="")return;const d=a.substring(0,a.lastIndexOf("/"))||"/";if(u(d),!l.has(a)){try{e.mkdir(a,493)}catch{}l.add(a)}}let i=0;for(const a of s.files){const d=a.path.substring(0,a.path.lastIndexOf("/"));u(d);const S=V(a.data),_=e.open(a.path,66,420);e.write(_,S,0,S.length),e.close(_),i++,n&&i%50===0&&n(i,s.files.length)}return n&&n(i,s.files.length),i}const K="/wasm-posix-kernel/assets/perl-tRv_TbRE.wasm",C=document.getElementById("terminal"),g=document.getElementById("start"),b=document.getElementById("stop"),w=document.getElementById("snippets"),L=document.getElementById("code"),$=document.getElementById("batch-output"),E=document.getElementById("run"),v=document.getElementById("examples"),h=document.getElementById("status"),x=document.getElementById("mode-interactive"),k=document.getElementById("mode-batch"),R=document.getElementById("interactive-view"),q=document.getElementById("batch-view"),I=new TextDecoder,T=new TextEncoder;x.addEventListener("click",()=>{x.classList.add("active"),k.classList.remove("active"),R.classList.remove("hidden"),q.classList.add("hidden")});k.addEventListener("click",()=>{k.classList.add("active"),x.classList.remove("active"),q.classList.remove("hidden"),R.classList.add("hidden")});function c(e,t){h.style.display="block",h.textContent=e,h.className=`status ${t}`}function A(){h.style.display="none"}let y=null,p=null;async function j(){if(y&&p)return"";c("Loading kernel + Perl (~3.5MB)...","loading");const e=await Promise.all([fetch(O).then(t=>t.arrayBuffer()),fetch(K).then(t=>t.arrayBuffer())]);return y=e[0],p=e[1],[`Kernel: ${(y.byteLength/1024).toFixed(0)}KB`,`Perl: ${(p.byteLength/(1024*1024)).toFixed(1)}MB`].join(", ")+`
`}const D=["HOME=/home","TMPDIR=/tmp","TERM=xterm-256color","LANG=en_US.UTF-8","PATH=/usr/local/bin:/usr/bin:/bin"];async function M(e){const t=new H({onStdout:e==null?void 0:e.onStdout,onStderr:e==null?void 0:e.onStderr});await t.init(y);const n=t.fs;for(const s of["/usr","/usr/lib","/usr/lib/perl5","/usr/lib/perl5/5.40.3","/tmp","/home"])try{n.mkdir(s,493)}catch{}c("Loading Perl stdlib...","loading");const r=await F(n,"/wasm-posix-kernel/perl-bundle.json",(s,l)=>{c(`Loading Perl stdlib... ${s}/${l} files`,"loading")});return c(`Stdlib loaded (${r} files). Starting Perl...`,"loading"),t}const N=`
use strict;
use warnings;
$| = 1;
my $v = $^V;
print "Perl $v REPL (eval loop)\\nType 'exit' to quit.\\n\\n";
while (1) {
    print "perl> ";
    my $line = <STDIN>;
    last unless defined $line;
    chomp $line;
    last if $line eq 'exit' || $line eq 'quit';
    next if $line eq '';
    no strict;
    no warnings;
    my @result = eval($line);
    use strict;
    use warnings;
    if ($@) {
        print STDERR "Error: $@";
    } elsif (@result) {
        for my $r (@result) {
            print defined($r) ? "$r\\n" : "undef\\n";
        }
    }
}
print "\\n";
`;function z(e,t,n){const r=T.encode(n),s=e.open(t,577,493);e.write(s,r,null,r.length),e.close(s)}let B=null,o=null;async function G(){g.disabled=!0,b.disabled=!1,C.innerHTML="";try{const e=await j(),t=await M();z(t.fs,"/tmp/repl.pl",N),B=t;const n=new U(C,t);o=n,e&&n.terminal.writeln(e.trimEnd()),c("Starting Perl REPL...","running"),A(),n.terminal.focus();const r=await n.spawn(p,["perl","/tmp/repl.pl"],{env:D});n.terminal.writeln(`\r
[Perl exited with code ${r}]`)}catch(e){o&&o.terminal.writeln(`\r
Error: ${e}`),c(`Error: ${e}`,"error"),console.error(e)}finally{B=null,g.disabled=!1,b.disabled=!0}}function X(){o&&(o.terminal.writeln(`\r
[Perl stopped]`),o.dispose(),o=null),B=null,g.disabled=!1,b.disabled=!0}g.addEventListener("click",G);b.addEventListener("click",X);w.addEventListener("change",()=>{const e={hello:'print "Hello, World!\\n"',version:'print "Perl $^V\\n"',array:'my @a = (1..5); print join(", ", @a), "\\n"',hash:'my %h = (a => 1, b => 2); print "$_=$h{$_} " for sort keys %h; print "\\n"',regex:'"Hello World" =~ /(\\w+)/g; print "Match: $1\\n"'},t=w.value;t&&e[t]&&o&&o.write(e[t]+`
`),w.value=""});const P={hello:`use strict;
use warnings;

print "Hello from Perl $^V on WebAssembly!\\n\\n";

print "Config:\\n";
print "  \\$^O = $^O\\n";
print "  \\$^V = $^V\\n";

my @features = qw(regex hashes arrays references closures);
print "\\nPerl features available:\\n";
print "  - $_\\n" for @features;
`,regex:`use strict;
use warnings;

my $text = "The quick brown fox jumps over the lazy dog at 3:45pm on 2024-01-15";

# Extract all words
my @words = ($text =~ /\\b([a-zA-Z]+)\\b/g);
print "Words: ", join(", ", @words), "\\n\\n";

# Extract time
if ($text =~ /(\\d{1,2}:\\d{2}(?:am|pm)?)/) {
    print "Time found: $1\\n";
}

# Extract date
if ($text =~ /(\\d{4}-\\d{2}-\\d{2})/) {
    print "Date found: $1\\n";
}

# Substitution
(my $censored = $text) =~ s/\\b(fox|dog)\\b/****/gi;
print "\\nCensored: $censored\\n";

# Split and rejoin
my @parts = split /\\s+/, $text;
print "\\nWord count: ", scalar @parts, "\\n";
print "Reversed: ", join(" ", reverse @parts), "\\n";
`,hash:`use strict;
use warnings;

# Hash of arrays (HoA)
my %students = (
    math    => [qw(Alice Bob Charlie)],
    science => [qw(Bob Diana Eve)],
    english => [qw(Alice Charlie Eve Frank)],
);

print "Class rosters:\\n";
for my $class (sort keys %students) {
    print "  $class: ", join(", ", @{$students{$class}}), "\\n";
}

# Count appearances
my %count;
for my $class (values %students) {
    $count{$_}++ for @$class;
}

print "\\nStudent course counts:\\n";
for my $student (sort { $count{$b} <=> $count{$a} || $a cmp $b } keys %count) {
    print "  $student: $count{$student} courses\\n";
}

# Find students in multiple classes
my @multi = grep { $count{$_} > 1 } sort keys %count;
print "\\nStudents in multiple classes: ", join(", ", @multi), "\\n";
`,file:`use strict;
use warnings;

# Write a file
my $path = "/tmp/perl-demo.txt";
open(my $fh, '>', $path) or die "Cannot open: $!";
for my $i (1..10) {
    printf $fh "Line %02d: %s\\n", $i, "x" x ($i * 3);
}
close($fh);
print "Wrote $path\\n";

# Read it back
open($fh, '<', $path) or die "Cannot open: $!";
my @lines = <$fh>;
close($fh);
chomp @lines;

print "Read ", scalar @lines, " lines\\n\\n";

# Process: show longest lines
my @sorted = sort { length($b) <=> length($a) } @lines;
print "Top 3 longest lines:\\n";
for my $i (0..2) {
    printf "  [%2d chars] %s\\n", length($sorted[$i]), $sorted[$i];
}

# Stats
my $total_chars = 0;
$total_chars += length($_) for @lines;
printf "\\nTotal characters: %d\\n", $total_chars;
printf "Average line length: %.1f\\n", $total_chars / scalar @lines;
`,functional:`use strict;
use warnings;

my @numbers = (1..20);

# map: transform
my @squares = map { $_ ** 2 } @numbers;
print "Squares: ", join(", ", @squares), "\\n";

# grep: filter
my @evens = grep { $_ % 2 == 0 } @numbers;
print "Evens: ", join(", ", @evens), "\\n";

# Chained: even squares
my @even_sq = grep { $_ % 2 == 0 } map { $_ ** 2 } @numbers;
print "Even squares: ", join(", ", @even_sq), "\\n\\n";

# sort with custom comparator
my @words = qw(banana apple cherry date elderberry fig grape);
my @by_length = sort { length($a) <=> length($b) || $a cmp $b } @words;
print "Sorted by length: ", join(", ", @by_length), "\\n";

# reduce (fold)
use List::Util qw(reduce sum max min);
my $product = reduce { $a * $b } 1..10;
printf "\\n10! = %d\\n", $product;
printf "Sum 1..20 = %d\\n", sum(@numbers);
printf "Max = %d, Min = %d\\n", max(@numbers), min(@numbers);

# Schwartzian transform (decorate-sort-undecorate)
my @files = qw(readme.txt main.c lib.h Makefile test.pl config.yml);
my @sorted = map  { $_->[0] }
             sort { $a->[1] cmp $b->[1] }
             map  { [$_, lc $_] }
             @files;
print "\\nCase-insensitive sort: ", join(", ", @sorted), "\\n";
`,oop:`use strict;
use warnings;

package Animal {
    sub new {
        my ($class, %args) = @_;
        return bless {
            name  => $args{name}  // "Unknown",
            sound => $args{sound} // "...",
        }, $class;
    }
    sub name  { $_[0]->{name} }
    sub sound { $_[0]->{sound} }
    sub speak {
        my $self = shift;
        printf "%s says %s!\\n", $self->name, $self->sound;
    }
}

package Dog {
    our @ISA = ('Animal');
    sub new {
        my ($class, %args) = @_;
        $args{sound} = "Woof";
        return $class->SUPER::new(%args);
    }
    sub fetch {
        my ($self, $item) = @_;
        printf "%s fetches the %s!\\n", $self->name, $item;
    }
}

package Cat {
    our @ISA = ('Animal');
    sub new {
        my ($class, %args) = @_;
        $args{sound} = "Meow";
        return $class->SUPER::new(%args);
    }
    sub purr {
        printf "%s purrs...\\n", $_[0]->name;
    }
}

package main;

my @pets = (
    Dog->new(name => "Rex"),
    Cat->new(name => "Whiskers"),
    Dog->new(name => "Buddy"),
    Cat->new(name => "Luna"),
);

for my $pet (@pets) {
    $pet->speak;
}

print "\\n";
$pets[0]->fetch("ball");
$pets[1]->purr;

# Polymorphism check
print "\\nAll animals:\\n";
for my $pet (@pets) {
    printf "  %s is a %s\\n", $pet->name, ref($pet);
}
`};function m(e,t){const n=document.createElement("span");t&&(n.className=t),n.textContent=e,$.appendChild(n),$.scrollTop=$.scrollHeight}async function W(){E.disabled=!0,$.textContent="";try{const e=await j();e&&m(e,"info");const t=L.value,n=await M({onStdout:i=>m(I.decode(i)),onStderr:i=>m(I.decode(i),"stderr")}),r="/tmp/script.pl",s=T.encode(t),l=n.fs.open(r,577,420);n.fs.write(l,s,null,s.length),n.fs.close(l),c("Running Perl...","running");const u=await n.spawn(p,["perl",r],{env:D});m(`
Exited with code ${u}
`,"info"),A()}catch(e){m(`
Error: ${e}
`,"stderr"),c(`Error: ${e}`,"error"),console.error(e)}finally{E.disabled=!1}}E.addEventListener("click",W);v.addEventListener("change",()=>{const e=v.value;e&&P[e]&&(L.value=P[e]),v.value=""});L.addEventListener("keydown",e=>{(e.ctrlKey||e.metaKey)&&e.key==="Enter"&&(e.preventDefault(),W())});
