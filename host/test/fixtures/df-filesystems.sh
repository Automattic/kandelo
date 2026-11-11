set -eu

fail() { printf '%s\n' "$*" >&2; exit 1; }

# Compare coreutils' enumeration and explicit-path forms with statvfs. Reject
# header-only output and placeholder statistics, including after a reboot.
check_row() {
    local filesystem total used available percent mount extra blocksize blocks free
    read -r filesystem total used available percent mount extra <<< "$1"
    test "$filesystem" = "$2"
    test "$mount" = "$3"
    test -z "$extra"
    test "$total" -gt 0
    test "$used" -ge 0
    test "$available" -ge 0
    test "$((used + available))" -eq "$total"
    read -r blocksize blocks free <<< "$(stat -f -c '%S %b %a' "$mount")"
    test "$total" -eq "$((blocksize * blocks / 1024))"
    test "$available" -eq "$((blocksize * free / 1024))"
}

check_df() {
    local output
    output=$(df -P -k "$1")
    printf '%s\n' "$output"
    mapfile -t rows <<< "$output"
    test "${#rows[@]}" -eq 2 || fail "df $1 did not report exactly one filesystem row"
    check_row "${rows[1]}" "$2" "$3"
}

df
all=$(df -P -k)
for mount in / /tmp /run /dev/shm /run/kandelo/exchange; do
    case "$mount" in
        /) source=kandelo-root ;;
        /run/kandelo/exchange) source=kandelo-exchange ;;
        *) source=tmpfs ;;
    esac
    found=0
    while IFS= read -r row; do
        if [[ "$row" = *" $mount" ]]; then
            check_row "$row" "$source" "$mount"
            found=$((found + 1))
        fi
    done <<< "$all"
    test "$found" -eq 1 || fail "df did not enumerate exactly one row for $mount"
    check_df "$mount" "$source" "$mount"
done
check_df /home/maker kandelo-root /

# mtab and both proc mounts paths expose the same ordinary mount list.
test "$(cat /etc/mtab)" = "$(cat /proc/mounts)"
test "$(cat /proc/mounts)" = "$(cat /proc/self/mounts)"
entries=0
declare -A mount_ids parent_ids
while read -r id parent device root mount options rest; do
    actual=$(stat -c %d "$mount")
    major=$((((actual >> 32) & 0xfffff000) | ((actual >> 8) & 0xfff)))
    minor=$((((actual >> 12) & 0xffffff00) | (actual & 0xff)))
    test "$device" = "$major:$minor" || fail "mountinfo device $device disagrees with stat $major:$minor at $mount"
    test "$root" = /
    test -z "${mount_ids[$mount]:-}"
    mount_ids[$mount]=$id
    parent_ids[$mount]=$parent
    entries=$((entries + 1))
done < /proc/self/mountinfo
test "$entries" -eq 8
test "${parent_ids[/dev/shm]}" = "${mount_ids[/dev]}"
test "${parent_ids[/run/kandelo/exchange]}" = "${mount_ids[/run]}"
# Coreutils stat reads statx: a device node must retain both rdev components.
test "$(stat -c '%t:%T' /dev/input/event0)" = d:40
printf 'DF_FILESYSTEMS_OK\n'
