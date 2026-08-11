# Kandelo's system default for interactive Bash login shells.
if [ -n "${BASH_VERSION-}" ]; then
    case $- in
        *i*)
            if [ "${TERM-}" = dumb ]; then
                PS1='\u@\h \w \$ '
            elif [ "${EUID-1}" -eq 0 ]; then
                PS1='\[\e]133;A\a\]\[\e[36m\]\u@\h \[\e[34m\]\w \[\e[31m\]❯\[\e[0m\] \[\e]133;B\a\]'
            else
                PS1='\[\e]133;A\a\]\[\e[36m\]\u@\h \[\e[34m\]\w \[\e[32m\]❯\[\e[0m\] \[\e]133;B\a\]'
            fi
            ;;
    esac
fi
