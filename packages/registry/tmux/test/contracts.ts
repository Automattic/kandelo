// Run identical guest commands on Node and browser hosts. wait-for observes
// shell completion rather than mistaking a successful client exit for it.
export const TMUX_CONTROL_SCRIPT = String.raw`
set -eu
export PATH=/usr/bin:/bin HOME=/tmp TERM=xterm-256color SHELL=/bin/sh
socket=kandelo-acceptance
t() { /usr/bin/tmux -L "$socket" -f /dev/null "$@"; }
trap 't kill-server 2>/dev/null || :' EXIT
t -V
t new-session -d -s trial -x 80 -y 24 'printf "TMUX_FIRST_READY\n"; /usr/bin/tmux -L kandelo-acceptance wait-for -S first-ready; IFS= read -r value; printf "TMUX_REPLY:%s\n" "$value"; /usr/bin/tmux -L kandelo-acceptance wait-for -S reply-ready; IFS= read -r value'
t wait-for first-ready
first=$(t capture-pane -p -t trial:0.0)
[[ "$first" == *TMUX_FIRST_READY* ]]
t split-window -h -t trial:0 'printf "TMUX_SECOND_READY\n"; /usr/bin/tmux -L kandelo-acceptance wait-for -S second-ready; IFS= read -r value'
t wait-for second-ready
panes=$(t list-panes -t trial:0 -F '#{pane_index}|#{pane_width}|#{pane_height}')
count=0
while IFS='|' read -r index width height; do
    ((width > 0 && height > 0))
    count=$((count + 1))
done <<< "$panes"
[[ "$count" == 2 ]]
printf 'TMUX_SPLIT_PASS\n'
t send-keys -t trial:0.0 hello-from-kandelo Enter
t wait-for reply-ready
reply=$(t capture-pane -p -t trial:0.0)
[[ "$reply" == *TMUX_REPLY:hello-from-kandelo* ]]
printf 'TMUX_INPUT_PASS\n'
t resize-window -t trial:0 -x 100 -y 32
size=$(t display-message -p -t trial:0 '#{window_width}x#{window_height}')
[[ "$size" == 100x32 ]]
printf 'TMUX_RESIZE_PASS\n'
t new-window -d -t trial -n extra 'printf "TMUX_WINDOW_READY\n"; /usr/bin/tmux -L kandelo-acceptance wait-for -S window-ready; IFS= read -r value'
t wait-for window-ready
windows=$(t list-windows -t trial -F '#{window_name}')
[[ "$windows" == *extra* ]]
printf 'TMUX_WINDOW_PASS\n'
t kill-server
trap - EXIT
printf 'TMUX_CONTROL_PASS\n'
`;

export const TMUX_CONTROL_MARKERS = [
  "tmux 3.8",
  "TMUX_SPLIT_PASS",
  "TMUX_INPUT_PASS",
  "TMUX_RESIZE_PASS",
  "TMUX_WINDOW_PASS",
  "TMUX_CONTROL_PASS",
];
