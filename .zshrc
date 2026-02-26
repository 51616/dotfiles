# TODO: refactor .zshrc to self-contain files to be sourced, this file is getting big!

# If you come from bash you might have to change your $PATH.
# export PATH="$PATH:/opt/nvim/" 
# export PATH=$HOME/bin:$HOME/.local/bin:/usr/local/bin:$PATH

export LESS='-R'
eval $(lesspipe)
# nice highlight in less by rich-cli
if command -v rich >/dev/null 2>&1; then
  # export LESSOPEN="|rich -n -g --force-terminal %s"
  export RICH_THEME=lightbulb
fi

if command -v nvim >/dev/null 2>&1; then
  # export LESSOPEN="|rich -n -g --force-terminal %s"
  export SUDO_EDITOR=$(which nvim)
  export EDITOR=$(which nvim)
fi

# faster paste
export DISABLE_MAGIC_FUNCTIONS=true

# Path to your oh-my-zsh installation.
omz="~/.oh-my-zsh"
export ZSH="${omz/#\~/$HOME}"

# Set name of the theme to load --- if set to "random", it will
# load a random theme each time oh-my-zsh is loaded, in which case,
# to know which specific one was loaded, run: echo $RANDOM_THEME
# See https://github.com/robbyrussell/oh-my-zsh/wiki/Themes
ZSH_THEME="robbyrussell"
# Set list of themes to pick from when loading at random
# Setting this variable when ZSH_THEME=random will cause zsh to load
# a theme from this variable instead of looking in ~/.oh-my-zsh/themes/
# If set to an empty array, this variable will have no effect.
# ZSH_THEME_RANDOM_CANDIDATES=( "robbyrussell" "agnoster" )

# Uncomment the following line to use case-sensitive completion.
# CASE_SENSITIVE="true"

# Uncomment the following line to use hyphen-insensitive completion.
# Case-sensitive completion must be off. _ and - will be interchangeable.
# HYPHEN_INSENSITIVE="true"

# Uncomment the following line to disable bi-weekly auto-update checks.
# DISABLE_AUTO_UPDATE="true"

# Uncomment the following line to change how often to auto-update (in days).
# export UPDATE_ZSH_DAYS=13

# Uncomment the following line to disable colors in ls.
# DISABLE_LS_COLORS="true"

# Uncomment the following line to disable auto-setting terminal title.
# DISABLE_AUTO_TITLE="true"

# Uncomment the following line to enable command auto-correction.
# ENABLE_CORRECTION="true"

# Uncomment the following line to display red dots whilst waiting for completion.
# COMPLETION_WAITING_DOTS="true"

# Uncomment the following line if you want to disable marking untracked files
# under VCS as dirty. This makes repository status check for large repositories
# much, much faster.
# DISABLE_UNTRACKED_FILES_DIRTY="true"

# Uncomment the following line if you want to change the command execution time
# stamp shown in the history command output.
# You can set one of the optional three formats:
# "mm/dd/yyyy"|"dd.mm.yyyy"|"yyyy-mm-dd"
# or set a custom format using the strftime function format specifications,
# see 'man strftime' for details.
HIST_STAMPS="yyyy-mm-dd"

# Would you like to use another custom folder than $ZSH/custom?
# ZSH_CUSTOM=/path/to/new-custom-folder

# Which plugins would you like to load?
# Standard plugins can be found in ~/.oh-my-zsh/plugins/*
# Custom plugins may be added to ~/.oh-my-zsh/custom/plugins/
# Example format: plugins=(rails git textmate ruby lighthouse)
# Add wisely, as too many plugins slow down shell startup.
plugins=(
  git
  z
  extract
  colored-man-pages
)

source $ZSH/oh-my-zsh.sh

HISTFILE=~/.zsh_history
HISTSIZE=999999999
SAVEHIST=$HISTSIZE

# Appends every command to the history file once it is executed
setopt inc_append_history

if [ -f ~/.bash_profile ]; then 
    . ~/.bash_profile;
fi


if [ -f ~/.bash_aliases ]; then
  source ~/.bash_aliases
fi

if [ -f ~/.profile.local ]; then
  source ~/.profile.local
fi

cdtm(){
  eval "z $1 && tmn $1"
}
alias ztm='cdtm'

# replace diff with delta if available
if command -v delta >/dev/null 2>&1; then
  alias diff='delta'
fi

if command -v tree >/dev/null 2>&1; then
  t(){
    local dir
    local depth
    local flags="-phCDF --dirsfirst --sort=name -I '.*\\.(idea|git|node_modules|venv).*|\\.DS_Store'"
    
    for arg in "$@"; do
      if [[ "$arg" == -* ]]; then
        flags+=" $arg"
      elif [ -z "$dir" ]; then
        dir="$arg"
      elif [ -z "$depth" ]; then
        depth="$arg"
      fi
    done
    dir="${dir:-.}"
    depth="${depth:-1}"
    eval "tree $dir -L $depth $flags"
  }
fi
# replace tree when eza is available
if command -v eza >/dev/null 2>&1; then
  t(){
    local dir
    local depth
    local flags="-l --icons=auto -F=auto --group-directories-first --color=auto -I '.*\\.(idea|git|venv|node_modules|venv).*|\\.DS_Store'"

    for arg in "$@"; do
      if [[ "$arg" == -* ]]; then
        flags+=" $arg"
      elif [ -z "$dir" ]; then
        dir="$arg"
      elif [ -z "$depth" ]; then
        depth="$arg"
      fi
    done
    dir="${dir:-.}"
    depth="${depth:-1}"
    eval "eza $dir -TL $depth $flags"
  }
  alias tsm="t -s=modified -r"
fi

dot(){
  if [[ "$#" -eq 0 ]]; then
    (cd /
    for i in $(dotfiles ls-files); do
      echo -n "$(dotfiles -c color.status=always status $i -s | sed 's#$i##')"
      echo -e "¬/$i¬\e[0;33m$(dotfiles -c color.ui=always log -1 --format='%s' -- $i)\e[0m"
    done
    ) | column -s=¬ -t
  else
    dotfiles $*
  fi
}

vdot(){
  FZF_DEFAULT_COMMAND='git --git-dir=$HOME/.dotfiles --work-tree=$HOME ls-files $HOME' fzf \
    --layout=reverse --bind 'enter:execute(nvim {})' --preview 'bat --color=always {}' --preview-window=right,70% --color header:italic --header 'Managed dotfiles' --bind 'change:reload:(eval "$FZF_DEFAULT_COMMAND")'
}

tma(){
  last_sess=$(tm ls -F '#{session_name} #{session_last_attached}' | sort -k2n | tail -n 1 | awk '{print $1}')
  # echo "$last_sess"
  local sess_name
  local args
  local flags=""
  for arg in "$@"; do
    if [[ "$arg" == -* ]]; then
        flags+=" $arg"
    elif [ -z "$sess_name" ]; then
        sess_name="$arg"
    fi
  done
  if [ -z "$sess_name" ]; then
    sess_name="$last_sess"
  fi
  eval "tmux a -t $flags $sess_name"
}

tm4() {
  tmux new-session \; \
  send-keys "cd $1" C-m \; \
  split-window -h \; \
  send-keys "cd $1" C-m \; \
  split-window -v \; \
  send-keys "cd $1" C-m \; \
  select-pane -t 0 \; \
  split-window -v \; \
  send-keys "cd $1" C-m \; \
  select-pane -t 0
}

ssync() {
  if [ -z "$1" ]; then
    echo "Usage: ssync <folder>"
    return
  fi
  cmd="ssh server 'rsync -hvrt --progress --update --delete \"/home/tan/research/$1\" cluster:\"/ist/ist-share/all/$1\"'"
  echo $cmd
  eval $cmd
}

fshere() {
  cmd="sshfs -o cache=no -o IdentityFile=/home/$USER/.ssh/id_rsa $USER@$@ $PWD"
  echo $cmd
  eval $cmd
  cd ..
  cd -
} 

source-git() {
  target=~/.zsh/$1:t:r
  plugin=$target/$1:t:r.plugin.zsh
  if [ ! -d "$target" ] ; then
    git clone $1 $target
    #echo "git clone $1 $target"
  fi
  if [ ! -f "$plugin" ]; then
    plugin=$target/$1:t:r
  fi
  source $plugin
}

_fix_cursor() {
   echo -ne '\e[5 q'
}

cmd_to_clip () { echo -n $BUFFER | xclip -sel clip }
zle -N cmd_to_clip
bindkey '^Y' cmd_to_clip
bindkey ' ' magic-space

### Fix slowness of pastes with zsh-syntax-highlighting.zsh
pasteinit() {
  OLD_SELF_INSERT=${${(s.:.)widgets[self-insert]}[2,3]}
  zle -N self-insert url-quote-magic # I wonder if you'd need `.url-quote-magic`?
}

pastefinish() {
  zle -N self-insert $OLD_SELF_INSERT
}
zstyle :bracketed-paste-magic paste-init pasteinit
zstyle :bracketed-paste-magic paste-finish pastefinish

# copy_last() {
#   echo !! | xclip -sel clip
# }

precmd_functions+=(_fix_cursor)

#UNAME=$(uname | tr "[:upper:]" "[:lower:]")
#if [[ "$UNAME" == "linux" ]]; then
  #export NOCONDA_PATH="$PATH:/usr/local/cuda-10.0/bin"
  #export PATH="$NOCONDA_PATH:/home2/supasorn/anaconda3/bin"
#
  #export LD_LIBRARY_PATH="$LD_LIBRARY_PATH:/usr/local/cuda-10.0/lib64:/usr/local/cuda/extras/CUPTI/lib64"
#fi
#
#hn="$(hostname)"
#if [[ $hn == "ROG504" ]]; then
  #tf-term() {
    #tmux new-session \; \
    #send-keys "$@" C-m \; \
    #send-keys "source ~/venv_tf2/bin/activate" C-m \; \
    #split-window -v \; \
    #send-keys "$@" C-m \; \
    #send-keys "source ~/venv_tf2/bin/activate" C-m \; \
    #send-keys "tensorboard --logdir=." C-m \; \
    #split-window -v \; \
    #send-keys "$@" C-m \; \
  #}
#
  #tl-term() {
    #tmux new-session \; \
    #send-keys "/home2/; python remote_timelapse.py" C-m \; \
    #split-window -h \; \
    #send-keys "/home2; python timelapse_day_maker_runner.py" C-m \; \
  #}
#
  #alias run="python /home2/research/orbiter/cluster_utils/tasklauncher.py"
  #alias tm="python /home2/research/orbiter/cluster_utils/tasklauncher.py tm"
  #alias rs="python /home2/research/orbiter/cluster_utils/rsync_folder.py"
#
#elif [[ $hn == "Supasorns-MacBook-Pro.local" ]]; then
  ####-tns-completion-start-###
  #if [ -f /Users/supasorn/.tnsrc ]; then 
      #source /Users/supasorn/.tnsrc 
  #fi
  ####-tns-completion-end-###
#fi

eval "$(oh-my-posh init zsh --config $HOME/.config/ohmyposh/zen.toml)"

# fix no match problem
unsetopt nomatch

# NVM
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"  # This loads nvm
[ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"  # This loads nvm bash_completion

# golang
# export PATH=$PATH:/usr/local/go/bin:$HOME/go/bin

# # copilot clip
# eval "$(github-copilot-cli alias -- "$0")"

# ZSH HIGHLIGHT COLORS
typeset -gA ZSH_HIGHLIGHT_STYLES
ZSH_HIGHLIGHT_HIGHLIGHTERS=(main brackets pattern)
# override main colors:
ZSH_HIGHLIGHT_STYLES[default]='none'
ZSH_HIGHLIGHT_STYLES[unknown-token]='fg=red,bold'
ZSH_HIGHLIGHT_STYLES[reserved-word]='fg=blue,bold'
ZSH_HIGHLIGHT_STYLES[assign]='fg=yellow,bold'
ZSH_HIGHLIGHT_STYLES[alias]='fg=50'
ZSH_HIGHLIGHT_STYLES[function]='fg=magenta,bold'
ZSH_HIGHLIGHT_STYLES[builtin]='fg=50'
ZSH_HIGHLIGHT_STYLES[command]='fg=50'
ZSH_HIGHLIGHT_STYLES[hashed-command]='fg=red,bold,standout'
ZSH_HIGHLIGHT_STYLES[commandseparator]='fg=190'
ZSH_HIGHLIGHT_STYLES[path]='fg=white,underline'
ZSH_HIGHLIGHT_STYLES[path_prefix]='fg=white,underline'
ZSH_HIGHLIGHT_STYLES[path_approx]='fg=green,bold'
ZSH_HIGHLIGHT_STYLES[globbing]='fg=yellow,bold'
ZSH_HIGHLIGHT_STYLES[history-expansion]='fg=yellow'
ZSH_HIGHLIGHT_STYLES[single-hyphen-option]='fg=39'
ZSH_HIGHLIGHT_STYLES[double-hyphen-option]='fg=39'
ZSH_HIGHLIGHT_STYLES[dollar-double-quoted-argument]='fg=cyan'
ZSH_HIGHLIGHT_STYLES[back-double-quoted-argument]='fg=blue'
ZSH_HIGHLIGHT_STYLES[single-quoted-argument]='fg=172'
ZSH_HIGHLIGHT_STYLES[double-quoted-argument]='fg=178'
ZSH_HIGHLIGHT_STYLES[rc-quote]='fg=177'
ZSH_HIGHLIGHT_STYLES[redirection]='fg=190'
ZSH_HIGHLIGHT_STYLES[arg0]='fg=45'

# override bracket colors:
ZSH_HIGHLIGHT_STYLES[bracket-error]='fg=red,bold'
# uniform / less distracting:
ZSH_HIGHLIGHT_STYLES[bracket-level-1]='fg=magenta,bold'
ZSH_HIGHLIGHT_STYLES[bracket-level-2]='fg=magenta'
ZSH_HIGHLIGHT_STYLES[bracket-level-3]='fg=magenta,bold'
ZSH_HIGHLIGHT_STYLES[bracket-level-4]='fg=magenta'
ZSH_HIGHLIGHT_STYLES[bracket-level-5]='fg=magenta,bold'
ZSH_HIGHLIGHT_STYLES[bracket-level-6]='fg=magenta'

# override pattern colors:
ZSH_HIGHLIGHT_PATTERNS+=('rm -[f,r] *' 'fg=red,bold,standout')
ZSH_HIGHLIGHT_PATTERNS+=('rm -[f,r][f,r] *' 'fg=red,bold,standout')
ZSH_HIGHLIGHT_PATTERNS+=('sudo dd *' 'fg=magenta,bold,standout')
ZSH_HIGHLIGHT_PATTERNS+=('sudo shred *' 'fg=magenta,bold,standout')
ZSH_AUTOSUGGEST_HIGHLIGHT_STYLE='fg=23'

# source additional zsh plugins
source-git https://github.com/supasorn/fzf-z.git
source-git https://github.com/Aloxaf/fzf-tab.git
# load the theme first
# source ~/.zsh/catppuccin_mocha-zsh-syntax-highlighting.zsh
source-git https://github.com/zsh-users/zsh-autosuggestions.git
source-git https://github.com/zsh-users/zsh-syntax-highlighting.git
# source-git https://github.com/zdharma-continuum/fast-syntax-highlighting

if ! (( ${+FZFZ_PREVIEW_COMMAND} )); then
    command -v eza >/dev/null 2>&1
    if [ $? -eq 0 ]; then
        # FZFZ_PREVIEW_COMMAND='tree -C -L 2 -x --noreport --dirsfirst {}'
        export FZFZ_PREVIEW_COMMAND='eza -TL 1 -h -F=always --color=always --group-directories-first --icons {}'
    else
        export FZFZ_PREVIEW_COMMAND='ls -1 -R {}'
    fi
fi

export FZF_DEFAULT_OPTS=" \
--color=fg:-1,bg:-1 \
--color=bg+:#313244,bg:#1e1e2e,spinner:#f5e0dc,hl:#f38ba8 \
--color=fg:#cdd6f4,header:#f38ba8,info:#cba6f7,pointer:#f5e0dc \
--color=marker:#f5e0dc,fg+:#cdd6f4,prompt:#cba6f7,hl+:#f38ba8 \
--border='rounded' --preview-window='border-rounded' --prompt=': ' \
--marker='>' --pointer='>>' --separator='─' --scrollbar='│'"
export FZFZ_SUBDIR_LIMIT=0
# export FZFZ_EXTRA_OPTS="--reverse"
# export FZF_CTRL_R_OPTS="--reverse"

# Preview file content using bat (https://github.com/sharkdp/bat)
export FZF_CTRL_T_OPTS="
  --preview 'bat -n --color=always {}'
  --bind 'ctrl-/:change-preview-window(down|hidden|)'"

# CTRL-/ to toggle small preview window to see the full command
# CTRL-Y to copy the command into clipboard using pbcopy
# enter to execute the command right away
export FZF_CTRL_R_OPTS="
  --preview 'echo {}'
  --preview-window up:3:hidden:wrap
  --bind 'ctrl-/:toggle-preview'
  --bind 'ctrl-y:execute-silent(echo -n {2..} | xclip -sel clip)+abort'
  --color header:italic
  --height 60%
  --header 'Press CTRL-/ to toggle preview, CTRL-Y to copy command into clipboard'"

# Print tree structure in the preview window
# export FZF_ALT_C_OPTS="--preview 'tree -C {}'"
export FZF_ALT_C_OPTS="--preview 'eza -TL 1 -h --color=always --group-directories-first --icons {}'" 

# common config for fzf-tab
# disable sort when completing `git checkout`
zstyle ':completion:*:git-checkout:*' sort false
# set descriptions format to enable group support
# NOTE: don't use escape sequences here, fzf-tab will ignore them
zstyle ':completion:*:descriptions' format '[%d]'
# set list-colors to enable filename colorizing
zstyle ':completion:*' list-colors ${(s.:.)LS_COLORS}
# force zsh not to show completion menu, which allows fzf-tab to capture the unambiguous prefix
zstyle ':completion:*' menu no
# switch group using `<` and `>`
zstyle ':fzf-tab:*' switch-group '<' '>'
# tmux integration
# zstyle ':fzf-tab:*' fzf-command ftb-tmux-popup
# give a preview of commandline arguments when completing `kill`
zstyle ':completion:*:*:*:*:processes' command "ps -u $USER -o pid,user,comm -w -w"
zstyle ':fzf-tab:complete:(kill|ps):argument-rest' fzf-preview \
  '[[ $group == "[process ID]" ]] && ps --pid=$word -o cmd --no-headers -w -w'
zstyle ':fzf-tab:complete:(kill|ps):argument-rest' fzf-flags --preview-window=down:3:wrap
zstyle ':fzf-tab:complete:(-command-|-parameter-|-brace-parameter-|export|unset|expand):*' \
	fzf-preview 'echo ${(P)word}'
zstyle ':fzf-tab:complete:systemctl-*:*' fzf-preview 'SYSTEMD_COLORS=1 systemctl status $word'


# custom
zstyle ':fzf-tab:*' continuous-trigger 'tab'
# zstyle ':fzf-tab:complete:less:*' fzf-preview 'eza -1 --color=always $realpath'
zstyle ':fzf-tab:complete:cd:*' fzf-preview 'less ${(Q)realpath}'
zstyle ':fzf-tab:complete:less:*' fzf-preview 'less ${(Q)realpath}'
zstyle ':fzf-tab:complete:bat:*' fzf-preview 'less ${(Q)realpath}'

# zstyle ':fzf-tab:complete:less:*' fzf-preview 'rich -n -g --force-terminal $realpath'

[ -f ~/.fzf.zsh ] && source ~/.fzf.zsh

fzf-history-widget() {
   local selected num
   setopt localoptions noglobsubst noposixbuiltins pipefail 2> /dev/null
   selected=( $(fc -rl 1 |
     FZF_DEFAULT_OPTS="--height ${FZF_TMUX_HEIGHT:-40%} $FZF_DEFAULT_OPTS --tiebreak=index --bind=ctrl-r:toggle-sort --expect=ctrl-e $FZF_CTRL_R_OPTS --query=${(qqq)LBUFFER} +m" $(__fzfcmd)) )
   local ret=$?
   if [ -n "$selected" ]; then
     local accept=0
     if [[ $selected[1] = ctrl-e ]]; then
       accept=1
       shift selected
       BUFFER="fc $selected[1]" && zle accept-line
       return $ret 
     fi
     num=$selected[1]
     if [ -n "$num" ]; then
       zle vi-fetch-history -n $num
       [[ $accept = 0 ]] && zle accept-line
     fi
   fi
   zle reset-prompt
   return $ret
}
zle     -N   fzf-history-widget
bindkey '^R' fzf-history-widget

