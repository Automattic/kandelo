import{B as L,k as j}from"./browser-kernel-DS31Lu-o.js";/* empty css               */import{P as M}from"./xterm-CyPUMFhC.js";const D="/wasm-posix-kernel/assets/perl-tRv_TbRE.wasm",k=document.getElementById("terminal"),$=document.getElementById("start"),f=document.getElementById("stop"),y=document.getElementById("snippets"),E=document.getElementById("code"),u=document.getElementById("batch-output"),g=document.getElementById("run"),h=document.getElementById("examples"),p=document.getElementById("status"),w=document.getElementById("mode-interactive"),b=document.getElementById("mode-batch"),P=document.getElementById("interactive-view"),S=document.getElementById("batch-view"),B=new TextDecoder,C=new TextEncoder;w.addEventListener("click",()=>{w.classList.add("active"),b.classList.remove("active"),P.classList.remove("hidden"),S.classList.add("hidden")});b.addEventListener("click",()=>{b.classList.add("active"),w.classList.remove("active"),S.classList.remove("hidden"),P.classList.add("hidden")});function d(e,t){p.style.display="block",p.textContent=e,p.className=`status ${t}`}function q(){p.style.display="none"}let l=null,c=null;async function I(){if(l&&c)return"";d("Loading kernel + Perl (~3.5MB)...","loading");const e=await Promise.all([fetch(j).then(t=>t.arrayBuffer()),fetch(D).then(t=>t.arrayBuffer())]);return l=e[0],c=e[1],[`Kernel: ${(l.byteLength/1024).toFixed(0)}KB`,`Perl: ${(c.byteLength/(1024*1024)).toFixed(1)}MB`].join(", ")+`
`}const R=["HOME=/home","TMPDIR=/tmp","TERM=xterm-256color","LANG=en_US.UTF-8","PATH=/usr/local/bin:/usr/bin:/bin"],W=`
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
`;function H(e,t,s){const n=C.encode(s),a=e.open(t,577,493);e.write(a,n,null,n.length),e.close(a)}let v=null,r=null;async function U(){$.disabled=!0,f.disabled=!1,k.innerHTML="";try{const e=await I(),t=new L;await t.init(l);const s=t.fs;for(const m of["/tmp","/home","/usr","/usr/bin"])try{s.mkdir(m,493)}catch{}H(s,"/tmp/repl.pl",W),v=t;const n=new M(k,t);r=n,e&&n.terminal.writeln(e.trimEnd()),d("Starting Perl REPL...","running"),q(),n.terminal.focus();const a=await n.spawn(c,["perl","/tmp/repl.pl"],{env:R});n.terminal.writeln(`\r
[Perl exited with code ${a}]`)}catch(e){r&&r.terminal.writeln(`\r
Error: ${e}`),d(`Error: ${e}`,"error"),console.error(e)}finally{v=null,$.disabled=!1,f.disabled=!0}}function V(){r&&(r.terminal.writeln(`\r
[Perl stopped]`),r.dispose(),r=null),v=null,$.disabled=!1,f.disabled=!0}$.addEventListener("click",U);f.addEventListener("click",V);y.addEventListener("change",()=>{const e={hello:'print "Hello, World!\\n"',version:'print "Perl $^V\\n"',array:'my @a = (1..5); print join(", ", @a), "\\n"',hash:'my %h = (a => 1, b => 2); print "$_=$h{$_} " for sort keys %h; print "\\n"',regex:'"Hello World" =~ /(\\w+)/g; print "Match: $1\\n"'},t=y.value;t&&e[t]&&r&&r.write(e[t]+`
`),y.value=""});const _={hello:`use strict;
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
`};function o(e,t){const s=document.createElement("span");t&&(s.className=t),s.textContent=e,u.appendChild(s),u.scrollTop=u.scrollHeight}async function T(){g.disabled=!0,u.textContent="";try{const e=await I();e&&o(e,"info");const t=E.value,s=new L({onStdout:i=>o(B.decode(i)),onStderr:i=>o(B.decode(i),"stderr")});await s.init(l);const n=s.fs;for(const i of["/tmp","/home"])try{n.mkdir(i,493)}catch{}const a="/tmp/script.pl",m=C.encode(t),x=n.open(a,577,420);n.write(x,m,null,m.length),n.close(x),d("Running Perl...","running");const A=await s.spawn(c,["perl",a],{env:R});o(`
Exited with code ${A}
`,"info"),q()}catch(e){o(`
Error: ${e}
`,"stderr"),d(`Error: ${e}`,"error"),console.error(e)}finally{g.disabled=!1}}g.addEventListener("click",T);h.addEventListener("change",()=>{const e=h.value;e&&_[e]&&(E.value=_[e]),h.value=""});E.addEventListener("keydown",e=>{(e.ctrlKey||e.metaKey)&&e.key==="Enter"&&(e.preventDefault(),T())});
