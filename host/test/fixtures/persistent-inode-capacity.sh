set -eu
maximum=$(((10 + 1024 + 1024 * 1024 + 1024 * 1024 * 1024) * 4096))

assert_hardlinks() {
    for name in hardlink-file hardlink-symbolic hardlink-fifo; do
        test "$(/bin/stat -c %i "/$name")" = "$(/bin/stat -c %i "/$name-alias")"
        test "$(/bin/stat -c %h "/$name")" -eq 2
    done
    IFS= read -r content < /hardlink-file
    test "$content" = 'hardlink state'
}

case "$1" in
    fill)
        exec 4< /deferred-orphan
        read -r filesystem total used free_before percent mount < <(/bin/df -Pk / | /bin/tail -n 1)
        /bin/rm /deferred-orphan
        read -r filesystem total used free_held percent mount < <(/bin/df -Pk / | /bin/tail -n 1)
        test "$free_held" -eq "$free_before" || {
            printf 'deferred metadata reclaimed before close: %s -> %s\n' "$free_before" "$free_held" >&2
            exit 102
        }
        exec 4<&-
        read -r filesystem total used free_after percent mount < <(/bin/df -Pk / | /bin/tail -n 1)
        test "$free_after" -gt "$free_held"
        /bin/dd if=/verified-reader of=/dev/null bs=65536 status=none
        read -r filesystem total used free_verified percent mount < <(/bin/df -Pk / | /bin/tail -n 1)
        test "$free_verified" -eq "$free_after" || {
            printf 'verified read changed allocation: %s -> %s\n' "$free_after" "$free_verified" >&2
            exit 108
        }
        test "$(/bin/dd if=/verified-reader bs=1 skip=5242880 count=1 status=none)" = V
        : > /block-quota
        : > /block-quota-remainder
        : > /block-quota-sparse
        read -r filesystem total used free_before percent mount < <(/bin/df -Pk / | /bin/tail -n 1)
        if /bin/dd if=/dev/zero of=/block-quota bs=4096 count="$((free_before / 4 + 2))" status=none 2>/dev/null; then exit 103; fi
        read -r filesystem total used free_held percent mount < <(/bin/df -Pk / | /bin/tail -n 1)
        if test "$free_held" -gt 0; then
            /bin/dd if=/dev/zero of=/block-quota-remainder bs=4096 count="$((free_held / 4))" status=none
        fi
        read -r filesystem total used free_full percent mount < <(/bin/df -Pk / | /bin/tail -n 1)
        test "$free_full" -eq 0
        if /bin/mkdir /block-quota-directory 2>/dev/null; then exit 105; fi
        if /bin/ln -s 'a-symbolic-link-target-longer-than-forty-bytes' /block-quota-link 2>/dev/null; then exit 106; fi
        test ! -e /block-quota-directory
        test ! -L /block-quota-link
        /bin/truncate -s 9663676424 /block-quota-sparse
        /bin/truncate -s 9663676417 /block-quota-sparse
        /bin/truncate -s 9663676424 /block-quota-sparse
        test "$(/bin/stat -c %s /block-quota-sparse)" -eq 9663676424
        printf -v quota_suffix '%0240d' 0
        quota_aliases=()
        for quota_number in {0..63}; do
            quota_name="/quota-alias-$quota_number-$quota_suffix"
            if /bin/ln /block-quota "$quota_name" 2>/dev/null; then
                quota_aliases+=("$quota_name")
            else
                break
            fi
        done
        test "${#quota_aliases[@]}" -gt 0
        test "${#quota_aliases[@]}" -lt 64
        test ! -e "$quota_name"
        printf Z | /bin/dd of=/block-quota bs=1 count=1 conv=notrunc status=none
        test "$(/bin/dd if=/block-quota bs=1 count=1 status=none)" = Z
        quota_size=$(/bin/stat -c %s /block-quota)
        test "$quota_size" -gt 0
        if printf X | /bin/dd of=/block-quota bs=1 seek="$quota_size" count=1 conv=notrunc status=none 2>/dev/null; then exit 104; fi
        test "$(/bin/stat -c %s /block-quota)" -eq "$quota_size"
        /bin/truncate -s 0 /block-quota
        read -r filesystem total used free_reclaimed percent mount < <(/bin/df -Pk / | /bin/tail -n 1)
        test "$free_reclaimed" -gt 0
        /bin/mkdir /block-quota-directory
        /bin/rmdir /block-quota-directory
        /bin/ln -s 'a-symbolic-link-target-longer-than-forty-bytes' /block-quota-link
        /bin/rm /block-quota-link "${quota_aliases[@]}"
        /bin/rm /block-quota /block-quota-remainder
        read -r filesystem total used free_after_quota percent mount < <(/bin/df -Pk / | /bin/tail -n 1)
        test "$free_after_quota" -eq "$free_before" || {
            printf 'sparse truncate allocated blocks: %s -> %s\n' "$free_before" "$free_after_quota" >&2
            exit 107
        }
        /bin/rm /block-quota-sparse
        /bin/persistence-overwrite logical-mmap-capacity
        /bin/persistence-overwrite verify-logical-mmap-capacity
        printf 'hardlink state\n' > /hardlink-file
        /bin/ln /hardlink-file /hardlink-file-alias
        /bin/ln -s hardlink-file /hardlink-symbolic
        /bin/ln -P /hardlink-symbolic /hardlink-symbolic-alias
        /bin/mkfifo /hardlink-fifo
        /bin/ln /hardlink-fifo /hardlink-fifo-alias
        assert_hardlinks
        : > /size-limit
        if printf X | /bin/dd of=/size-limit bs=1 seek="$maximum" count=1 conv=notrunc status=none 2>/dev/null; then exit 98; fi
        if /bin/truncate -s "$((maximum + 1))" /size-limit 2>/dev/null; then exit 99; fi
        test "$(/bin/stat -c %s /size-limit)" -eq 0
        if printf XYZ | /bin/dd of=/size-limit bs=1 seek="$((maximum - 1))" count=3 conv=notrunc status=none 2>/dev/null; then exit 100; fi
        test "$(/bin/stat -c %s /size-limit)" -eq "$maximum"
        test "$(/bin/dd if=/size-limit bs=1 skip="$((maximum - 1))" count=1 status=none)" = X
        count=0
        while { : > "/fill-$count"; } 2>/dev/null; do
            count=$((count + 1))
            test "$count" -lt 1024
        done
        test "$count" -gt 2
        read -r filesystem total used free percent mount < <(/bin/df -Pi / | /bin/tail -n 1)
        test "$free" -eq 0
        if /bin/mkdir /blocked-dir 2>/dev/null; then exit 94; fi
        if /bin/ln -s fill-1 /blocked-symlink 2>/dev/null; then exit 95; fi
        if /bin/mkfifo /blocked-fifo 2>/dev/null; then exit 96; fi
        printf 'retained orphan block\n' > /fill-0
        printf X | /bin/dd of=/fill-0 bs=1 seek=9663676423 count=1 conv=notrunc status=none
        read -r filesystem total used free_before percent mount < <(/bin/df -Pk / | /bin/tail -n 1)
        exec 3<> /fill-0
        /bin/rm /fill-0
        read -r filesystem total used free percent mount < <(/bin/df -Pi / | /bin/tail -n 1)
        test "$free" -eq 0
        read -r filesystem total used free_held percent mount < <(/bin/df -Pk / | /bin/tail -n 1)
        test "$free_held" -eq "$free_before" || {
            printf 'open-unlinked blocks reclaimed before close: %s -> %s\n' "$free_before" "$free_held" >&2
            exit 97
        }
        if { : > /blocked; } 2>/dev/null; then exit 91; fi
        exec 3>&-
        read -r filesystem total used free percent mount < <(/bin/df -Pi / | /bin/tail -n 1)
        test "$free" -eq 1
        read -r filesystem total used free_after percent mount < <(/bin/df -Pk / | /bin/tail -n 1)
        test "$free_after" -gt "$free_before"
        : > /replacement
        /bin/sync
        printf 'INODE_CAPACITY_FILLED\n'
        ;;
    recover)
        test "$(/bin/dd if=/verified-reader bs=1 skip=5242880 count=1 status=none)" = V
        /bin/persistence-overwrite verify-logical-mmap-capacity
        assert_hardlinks
        test "$(/bin/stat -c %s /size-limit)" -eq "$maximum"
        test "$(/bin/dd if=/size-limit bs=1 skip="$((maximum - 1))" count=1 status=none)" = X
        test -e /replacement
        test ! -e /fill-0
        test ! -e /blocked
        if { : > /blocked; } 2>/dev/null; then exit 92; fi
        /bin/rm /fill-1
        : > /after-reboot
        /bin/sync
        printf 'INODE_CAPACITY_RECOVERED\n'
        ;;
    checkpoint)
        test "$(/bin/dd if=/verified-reader bs=1 skip=5242880 count=1 status=none)" = V
        /bin/persistence-overwrite verify-logical-mmap-capacity
        assert_hardlinks
        printf 'checkpoint data\n' > /hardlink-file-alias
        IFS= read -r content < /hardlink-file
        test "$content" = 'checkpoint data'
        test "$(/bin/stat -c %s /size-limit)" -eq "$maximum"
        test "$(/bin/dd if=/size-limit bs=1 skip="$((maximum - 1))" count=1 status=none)" = X
        read -r filesystem total used free percent mount < <(/bin/df -Pi / | /bin/tail -n 1)
        test "$free" -eq 0
        if { : > /blocked; } 2>/dev/null; then exit 101; fi
        /bin/rm /after-reboot
        : > /after-checkpoint
        /bin/sync
        printf 'INODE_CAPACITY_CHECKPOINTED\n'
        ;;
    *) exit 93 ;;
esac
