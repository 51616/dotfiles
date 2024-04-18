# Enable Powerlevel10k instant prompt. Should stay close to the top of ~/.zshrc.
# Initialization code that may require console input (password prompts, [y/n]
# confirmations, etc.) must go above this block, everything else may go below.
if [[ -r "${XDG_CACHE_HOME:-$HOME/.cache}/p10k-instant-prompt-${(%):-%n}.zsh" ]]; then
  source "${XDG_CACHE_HOME:-$HOME/.cache}/p10k-instant-prompt-${(%):-%n}.zsh"
fi

# TODO: refactor .zshrc to self-contain files to be sourced, this file is getting big!

# If you come from bash you might have to change your $PATH.
export PATH="$PATH:/opt/nvim/" 
export PATH=$HOME/bin:$HOME/.local/bin:/usr/local/bin:$PATH

export LESS='-R'
eval $(lesspipe)
# nice highlight in less by rich-cli
if command -v rich >/dev/null 2>&1; then
  # export LESSOPEN="|rich -n -g --force-terminal %s"
  export RICH_THEME=lightbulb
fi

if command -v nvim >/dev/null 2>&1; then
  # export LESSOPEN="|rich -n -g --force-terminal %s"
  export SUDO_EDITOR=/opt/nvim/nvim
  export EDITOR=opt/nvim/nvim 
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
ZSH_THEME="powerlevel10k/powerlevel10k"
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

export FZFZ_SUBDIR_LIMIT=0
export FZFZ_EXTRA_OPTS="--reverse"
export FZF_CTRL_R_OPTS="--reverse"

export LD_LIBRARY_PATH="/usr/local/lib/"

# export TERM="xterm-256color"

# tomasr/molokai
# export FZF_DEFAULT_OPTS='--color=fg:-1,bg:-1,bg+:#293739,border:#808080,spinner:#E6DB74,hl:#7E8E91,header:#7E8E91,info:#A6E22E,pointer:#A6E22E,marker:#F92672,fg+:#F8F8F2,prompt:#F92672,hl+:#F92672'

# export FZF_DEFAULT_OPTS='--color=fg:-1,fg+:#d0d0d0,bg:-1,bg+:#262626
#   --color=hl:#5f87af,hl+:#5fd7ff,info:#afaf87,marker:#87ff00
#   --color=prompt:#d7005f,spinner:#af5fff,pointer:#87ff00,header:#87afaf
#   --color=border:#262626,query:#d9d9d9
#   --border="rounded" --preview-window="border-rounded" --prompt=": "
#   --marker=">" --pointer=">>" --separator="─" --scrollbar="│"'

export FZF_DEFAULT_OPTS=" \
--color=fg:-1,bg:-1 \
--color=bg+:#313244,bg:#1e1e2e,spinner:#f5e0dc,hl:#f38ba8 \
--color=fg:#cdd6f4,header:#f38ba8,info:#cba6f7,pointer:#f5e0dc \
--color=marker:#f5e0dc,fg+:#cdd6f4,prompt:#cba6f7,hl+:#f38ba8 \
--border='rounded' --preview-window='border-rounded' --prompt=': ' \
--marker='>' --pointer='>>' --separator='─' --scrollbar='│'"


if [ -f ~/.bash_aliases ]; then
. ~/.bash_aliases
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
  FZF_DEFAULT_COMMAND='git --git-dir=$HOME/.dotfiles --work-tree=$HOME ls-files' fzf \
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

# gh-copilot-cli functions
explain(){
  eval "gh copilot explain '$@'"
}

suggest(){
  eval "gh copilot suggest '$@'"
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

set_camera() {
  v4l2-ctl --set-ctrl zoom_absolute=140
  v4l2-ctl --set-ctrl sharpness=160
  v4l2-ctl --set-ctrl brightness=80
  v4l2-ctl --set-ctrl white_balance_temperature_auto=0
  v4l2-ctl --set-ctrl white_balance_temperature=4700
}

# copy_line_to_x_clipboard () {
#   printf %s "$READLINE_LINE" | xclip -sel clip
# }
# zle -N copy_line_to_x_clipboard
# bindkey '^U' copy_line_to_x_clipboard # binded to ctrl-u

cmd_to_clip () { xclip -sel clip <<< $BUFFER }
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

# To customize prompt, run `p10k configure` or edit ~/.p10k.zsh.
[[ -f ~/.p10k.zsh ]] && source ~/.p10k.zsh

# fix no match problem
unsetopt nomatch

# TODO: dont do conda init on zsh
# TODO: move this block to another file
# >>> conda initialize >>>
# !! Contents within this block are managed by 'conda init' !!
__conda_setup="$('/home/tan/miniconda3/bin/conda' 'shell.zsh' 'hook' 2> /dev/null)"
if [ $? -eq 0 ]; then
    eval "$__conda_setup"
else
    if [ -f "/home/tan/miniconda3/etc/profile.d/conda.sh" ]; then
        . "/home/tan/miniconda3/etc/profile.d/conda.sh"
    else
        export PATH="/home/tan/miniconda3/bin:$PATH"
    fi
fi
unset __conda_setup
# <<< conda initialize <<<
# set path

# hn="$(hostname)"
# if [[ $hn == "51616" ]]; then
#   conda activate python39
# fi
# PATH="/home/tan/miniconda3/bin:$PATH" # always add base conda env to path

# CONDA_PREFIX=${CONDA_PREFIX:-"$(dirname $(which conda))/../"}
# export CPATH=${CONDA_PREFIX}/include:${CPATH}
# export LIBRARY_PATH=${CONDA_PREFIX}/lib:${LIBRARY_PATH}
# export LD_LIBRARY_PATH=${CONDA_PREFIX}/lib:${LD_LIBRARY_PATH}

export LD_LIBRARY_PATH=${HOME}/.mujoco/mujoco200/bin:${LD_LIBRARY_PATH}
export LD_PRELOAD=/usr/lib/x86_64-linux-gnu/libGLEW.so

# conda utils
if command -v conda >/dev/null 2>&1; then
    # deactivate all conda envs
    deact() {
        while [ ! -z $CONDA_PREFIX ]; do conda deactivate; done
    }
    alias act='conda activate'
    # vact
    vact() {
        # current path venv folder
        rel_venv_path=$(ls -a | grep venv)
        # check if venv exists
        if [ -z $rel_venv_path ]; then
            echo "No venv found in current path"
            return
        fi
        eval "act $rel_venv_path/"
    }
    # automate conda env create and symlink to current path
    venv_here() {
      eval "conda create $@"
      # get env name, arg that follows -n or --name with a white space
      env_name=$(echo $@ | grep -m1 -oP '(?<=--name |-n )([\S]+)')
      eval "act" # activate base env just to get $CONDA_PREFIX
      # eval "echo $CONDA_PREFIX/envs/$env_name"
      eval "ln -s $CONDA_PREFIX/envs/$env_name .venv"
      eval "deact"
    }
fi


# poetry
export PATH="$HOME/.poetry/bin:$PATH"

# SC2
export SC2PATH='/home/tan/research/coop_marl/StarCraftII'

# ROS
# export PATH="/usr/lib/llvm-10/bin:$PATH"
# export MANPATH="/home/linuxbrew/.linuxbrew/share/man:$MANPATH"
# export INFOPATH="/home/linuxbrew/.linuxbrew/share/info:$INFOPATH"
# export PATH="/home/tan/.local/share/solana/install/active_release/bin:$PATH"
# export PATH="/home/tan/.avm/bin:$PATH"
# export ROS_HOSTNAME=localhost # 10.204.226.74 # localhost
# export ROS_MASTER_URI=http://localhost:11311 # http://10.204.226.74:11311 # http://localhost:11311
# source /opt/ros/melodic/setup.zsh

# NVM
# export NVM_DIR="$HOME/.nvm"
# [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"  # This loads nvm
# [ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"  # This loads nvm bash_completion

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

# Preview file content using bat (https://github.com/sharkdp/bat)
export FZF_CTRL_T_OPTS="
  --preview 'bat -n --color=always {}'
  --bind 'ctrl-/:change-preview-window(down|hidden|)'"

# CTRL-/ to toggle small preview window to see the full command
# CTRL-Y to copy the command into clipboard using pbcopy
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

# # zoxide (must be at the end)
# _ZO_ECHO=1
# eval "$(zoxide init --cmd cd zsh)"

[ -f ~/.fzf.zsh ] && source ~/.fzf.zsh
