alias zshrc='vim ~/.zshrc'
alias reload='source ~/.zshrc'
alias clock='tty-clock -c -C 6 -s'
alias crt='cool-retro-term'
alias clang='clang-10'
alias clang++='clang++-10'
alias cm='chezmoi'

# some more ls aliases
alias ll='ls -alF'
alias la='ls -A'
alias l='ls -CF'

alias vim="nvim"
alias vi="nvim"
alias v="nvim"
alias space="du -hs * | sort -h"
alias rg1="rg --max-depth=1"
# alias dotcd="~/.local/share/chezmoi"
# alias dotcd="cd $(chezmoi source-path)"
alias dotfiles='git --git-dir=$HOME/.dotfiles --work-tree=$HOME'

alias tm="tmux"
alias tmn="tmux new -s"
# alias tma="tmux a"

# alias ll='n -deH'
alias rgf='rg --files | rg'
alias c!="fc -ln -1 | xclip -sel clip"
alias pdfdiff="/home/tan/git/pdfdiff/pdfdiff.py"
alias copy="xclip -sel clip"

alias lg='lazygit'

