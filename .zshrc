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

# Manual Zsh init. Preserve the old OMZ-era behavior without loading the
# Oh My Zsh framework at runtime.
autoload -Uz compinit colors select-word-style
colors
compinit

# Use editor-style word movement for ZLE widgets like backward-word/forward-word.
select-word-style bash

# Uncomment the following line if you want to change the command execution time
# stamp shown in the history command output.
# You can set one of the optional three formats:
# "mm/dd/yyyy"|"dd.mm.yyyy"|"yyyy-mm-dd"
# or set a custom format using the strftime function format specifications,
# see 'man strftime' for details.
HIST_STAMPS="yyyy-mm-dd"

HISTFILE=~/.zsh_history
HISTSIZE=999999999
SAVEHIST=$HISTSIZE

# Appends every command to the history file once it is executed
setopt inc_append_history
# Entering a directory path as a command changes into it, matching OMZ behavior.
setopt auto_cd

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

compdef _cd t

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

cmd_to_clip () { print -rn -- "$BUFFER" | pi-copy-to-clipboard }
zle -N cmd_to_clip
bindkey '^Y' cmd_to_clip
bindkey ' ' self-insert

for keymap in emacs viins vicmd; do
  [[ -n ${terminfo[kLFT5]} ]] && bindkey -M "$keymap" "${terminfo[kLFT5]}" backward-word
  [[ -n ${terminfo[kRIT5]} ]] && bindkey -M "$keymap" "${terminfo[kRIT5]}" forward-word
  bindkey -M "$keymap" '^[[1;5D' backward-word
  bindkey -M "$keymap" '^[[1;5C' forward-word
  bindkey -M "$keymap" '^[[5D' backward-word
  bindkey -M "$keymap" '^[[5C' forward-word
done

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

_pi_omp_redraw_prompt_on_resize() {
  (( ${+functions[_omp_get_prompt]} )) || return 0
  [[ -o zle ]] || return 0

  # The Oh My Posh filler depends on terminal width; recompute it after resize.
  eval "$(_omp_get_prompt primary --eval)"
  zle reset-prompt 2>/dev/null
  zle -R 2>/dev/null
}

TRAPWINCH() {
  _pi_omp_redraw_prompt_on_resize
  return 0
}

# fix no match problem
unsetopt nomatch

# NVM
export NVM_DIR="$HOME/.nvm"
# Keep node/npm available without paying nvm's startup cost in every shell.
_nvm_default_bins=("$NVM_DIR"/versions/node/v*/bin(N-/On[1]))
if (( ${#_nvm_default_bins} )); then
  case ":$PATH:" in
    *":${_nvm_default_bins[1]}:"*) :;;
    *) export PATH="${_nvm_default_bins[1]}:$PATH";;
  esac
  export NVM_BIN="${_nvm_default_bins[1]}"
  export NVM_INC="${_nvm_default_bins[1]:h}/include/node"
fi
unset _nvm_default_bins

_nvm_load() {
  [ -s "$NVM_DIR/nvm.sh" ] || return 127
  unset -f nvm _nvm_load
  . "$NVM_DIR/nvm.sh"
  [ -s "$NVM_DIR/bash_completion" ] && . "$NVM_DIR/bash_completion"
}

nvm() {
  _nvm_load && nvm "$@"
}

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
[ -f "$HOME/.zsh/compat/omz-git.plugin.zsh" ] && source "$HOME/.zsh/compat/omz-git.plugin.zsh"
[ -f "$HOME/.zsh/fzf-z/z.sh" ] && source "$HOME/.zsh/fzf-z/z.sh"
[ -f "$HOME/.zsh/compat/omz-extract.plugin.zsh" ] && source "$HOME/.zsh/compat/omz-extract.plugin.zsh"
[ -f "$HOME/.zsh/compat/omz-colored-man-pages.plugin.zsh" ] && source "$HOME/.zsh/compat/omz-colored-man-pages.plugin.zsh"
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
# CTRL-E to paste the selected command into the prompt without executing it
# CTRL-Y to copy the command into clipboard, preferring tmux
# Enter executes the command right away
export FZF_CTRL_R_OPTS="
  --preview 'echo {}'
  --preview-window up:3:hidden:wrap
  --bind 'ctrl-/:toggle-preview'
  --bind 'ctrl-y:execute-silent(printf %s {2..} | pi-copy-to-clipboard)+abort'
  --color header:italic
  --height 60%
  --header 'Press CTRL-/ to toggle preview, CTRL-E to paste into prompt, CTRL-Y to copy via tmux/system clipboard'"

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
# If normal prefix completion finds nothing, allow case-insensitive substring matches.
zstyle ':completion:*' matcher-list '' 'm:{[:lower:][:upper:]}={[:upper:][:lower:]} l:|=* r:|=*'
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
zstyle ':fzf-tab:complete:(cd|t):*' fzf-preview 'if command -v eza >/dev/null 2>&1; then eza -TL 1 -h --color=always --group-directories-first --icons ${(Q)realpath}; elif command -v tree >/dev/null 2>&1; then tree -phCDF --dirsfirst --sort=name -L 1 ${(Q)realpath}; else ls -la ${(Q)realpath}; fi'
zstyle ':fzf-tab:complete:less:*' fzf-preview 'less ${(Q)realpath}'
zstyle ':fzf-tab:complete:bat:*' fzf-preview 'less ${(Q)realpath}'

# zstyle ':fzf-tab:complete:less:*' fzf-preview 'rich -n -g --force-terminal $realpath'

[ -f ~/.fzf.zsh ] && source ~/.fzf.zsh

# Safely tilde-expand a token like ~, ~user, or ~/foo to its filesystem path.
# Prints the expanded path and returns 0 if it resolves to an existing
# directory; otherwise prints nothing and returns 1.
#
# Splits on the first slash so we only feed the tilde head to `eval`. The
# head is whitelisted to ~ or ~<wordlike>, which keeps inputs containing
# shell metacharacters ($, `, ;, ...) from ever reaching `eval`. The rest
# of the path is single-quoted via (q). Stderr is swallowed so a typo like
# ~nosuchuser cannot spill onto the prompt when nomatch is set.
_pi_path_tilde_dir() {
  setopt localoptions extendedglob nomatch
  local input="$1" head_tok rest expanded
  if [[ "$input" == */* ]]; then
    head_tok="${input%%/*}"
    rest="/${input#*/}"
  else
    head_tok="$input"
    rest=""
  fi
  [[ "$head_tok" == "~" || "$head_tok" == "~"[A-Za-z_][A-Za-z0-9_-]# ]] || return 1
  expanded=$(eval "print -rn -- ${head_tok}${(q)rest}" 2>/dev/null) || return 1
  [[ -n "$expanded" && "$expanded" != "$input" && -d "$expanded" ]] || return 1
  print -rn -- "$expanded"
}

_pi_path_only_complete() {
  local current before search_dir typed selected candidate candidate_path preview_prefix selected_path selected_dir
  local command_word word selection selected_key directory_only=0 force_fzf=0 continue_requested=0
  local -a command_words raw_candidates path_candidates

  command_words=(${(z)LBUFFER})
  for word in "${command_words[@]}"; do
    case "$word" in
      command|builtin|exec|noglob|nocorrect|*=*) continue ;;
      *) command_word="$word"; break ;;
    esac
  done
  case "$command_word" in
    cd|chdir|pushd|t|rmdir) directory_only=1 ;;
    *) [[ "${_comps[$command_word]-}" == "_cd" ]] && directory_only=1 ;;
  esac

  current="${LBUFFER##*[[:space:]]}"
  before="${LBUFFER[1,$(( ${#LBUFFER} - ${#current} ))]}"

  while true; do
    raw_candidates=()
    path_candidates=()

    # Use ${~search_dir} below so a leading ~ / ~user in the typed prefix is
    # tilde-expanded for the filesystem test and glob (plain ${var} would not).
    if [[ "$current" == */ ]]; then
      search_dir="${current%/}"
      [[ -z "$search_dir" && "$current" == "/" ]] && search_dir="/"
      typed=""
      if [[ -n "$search_dir" && -d ${~search_dir} ]]; then
        raw_candidates=(${~search_dir}/*(N))
      fi
    elif [[ "$current" == */* ]]; then
      search_dir="${current:h}"
      typed="${current:t}"
      if [[ -n "$search_dir" && -d ${~search_dir} ]]; then
        if [[ "$typed" == .* ]]; then
          raw_candidates=(${~search_dir}/.*(N))
        else
          raw_candidates=(${~search_dir}/*(N))
        fi
      fi
    elif [[ "$current" == "~"* ]] && _pi_path_tilde_dir "$current" >/dev/null; then
      # Bare ~ or ~user with no trailing slash: treat the tilde token as the
      # search dir and list its contents, same as if the user had typed ~/.
      # The _pi_path_tilde_dir helper swallows "no such user" errors so a
      # bogus ~typo<TAB> never spills an error onto the prompt regardless of
      # the current nomatch setting.
      search_dir="$current"
      typed=""
      raw_candidates=(${~search_dir}/*(N))
    else
      search_dir=""
      typed="$current"
      if [[ "$typed" == .* ]]; then
        raw_candidates=(.*(N))
      else
        raw_candidates=(*(N))
      fi
    fi

    for candidate_path in "${raw_candidates[@]}"; do
      (( directory_only )) && [[ ! -d "$candidate_path" ]] && continue
      candidate="${candidate_path:t}"
      [[ -d "$candidate_path" ]] && candidate+="/"
      if [[ -z "$typed" || "${(L)candidate}" == *"${(L)typed}"* ]]; then
        path_candidates+=("$candidate")
      fi
    done

    if (( ! ${#path_candidates} )); then
      zle reset-prompt
      zle -R
      (( force_fzf )) && return 0
      return 1
    fi

    if (( ${#path_candidates} == 1 )); then
      selected="${path_candidates[1]}"
      selected_key="tab"
    else
      preview_prefix="${search_dir:+$search_dir/}"
      # Same tilde trap as the LBUFFER insertion: (q) escapes a leading ~,
      # which the sh subshell that fzf spawns won't tilde-expand. Keep ~ raw.
      local quoted_preview="${(q)preview_prefix}"
      quoted_preview="${quoted_preview/#\\~/~}"
      selection=$(
        printf '%s\n' "${path_candidates[@]}" |
          fzf --height="${FZF_TMUX_HEIGHT:-40%}" --layout=reverse --query="$typed" --expect=tab,enter \
            --preview "if [ -d ${quoted_preview}{} ]; then eza -TL 1 -h --color=always --group-directories-first --icons ${quoted_preview}{} 2>/dev/null || ls -la ${quoted_preview}{}; else bat -n --color=always ${quoted_preview}{} 2>/dev/null || sed -n '1,120p' ${quoted_preview}{}; fi"
      ) || {
        zle reset-prompt
        zle -R
        (( force_fzf )) && return 0
        return 1
      }
      selected_key="${selection%%$'\n'*}"
      selected="${selection#*$'\n'}"
      [[ "$selection" != *$'\n'* ]] && selected_key="enter"
      [[ -n "$selected" ]] || return 1
    fi

    selected_path="${search_dir:+$search_dir/}${selected}"
    selected_dir="${selected_path%/}"
    # (q) escapes everything including a leading ~, which would suppress
    # tilde expansion at exec time (e.g. `cd \~/foo` fails). Keep the leading
    # ~ literal so the user-visible form stays ~/foo and still expands.
    local quoted_selected="${(q)selected_path}"
    quoted_selected="${quoted_selected/#\\~/~}"
    LBUFFER="${before}${quoted_selected}"
    zle reset-prompt
    zle -R

    continue_requested=0
    [[ "$selected_key" == "tab" ]] && continue_requested=1
    # ${~selected_dir} so a tilde-prefixed path (e.g. ~/.config) is expanded
    # for the -d test; otherwise the "tab again to descend" branch is skipped
    # for ~/... selections and the widget exits early.
    if (( continue_requested )) && [[ "$selected" == */ && -d ${~selected_dir} ]]; then
      current="$selected_path"
      force_fzf=1
      continue
    fi
    return 0
  done
}
zle -N pi-path-only-complete _pi_path_only_complete

(( ${+functions[disable-fzf-tab]} )) && disable-fzf-tab
bindkey '^I' expand-or-complete
(( ${+functions[enable-fzf-tab]} )) && enable-fzf-tab
_pi_full_completion_widget=expand-or-complete
(( ${+widgets[fzf-tab-complete]} )) && _pi_full_completion_widget=fzf-tab-complete
for keymap in emacs viins; do
  bindkey -M "$keymap" '^I' pi-path-only-complete
  [[ -n ${terminfo[kcbt]} ]] && bindkey -M "$keymap" "${terminfo[kcbt]}" "$_pi_full_completion_widget"
  bindkey -M "$keymap" $'\e[Z' "$_pi_full_completion_widget"
done
unset _pi_full_completion_widget

fzf-history-widget() {
   local selected num
   setopt localoptions noglobsubst noposixbuiltins pipefail 2> /dev/null
   selected=( $(fc -rl 1 |
     FZF_DEFAULT_OPTS="--height ${FZF_TMUX_HEIGHT:-40%} $FZF_DEFAULT_OPTS --tiebreak=index --bind=ctrl-r:toggle-sort --expect=ctrl-e $FZF_CTRL_R_OPTS --query=${(qqq)LBUFFER} +m" $(__fzfcmd)) )
   local ret=$?
   if [ -n "$selected" ]; then
     if [[ $selected[1] = ctrl-e ]]; then
       shift selected
       num=$selected[1]
       if [ -n "$num" ]; then
         # Do not use `fc $num` here: fc opens $EDITOR. Fetch the history
         # event directly so CTRL-E only pastes it into the prompt.
         zle vi-fetch-history -n $num
         CURSOR=${#BUFFER}
       fi
     else
       num=$selected[1]
       if [ -n "$num" ]; then
         zle vi-fetch-history -n $num
         zle accept-line
       fi
     fi
   fi
   zle reset-prompt
   return $ret
}
zle     -N   fzf-history-widget
bindkey '^R' fzf-history-widget


# bun completions
[ -s "/home/tan/.bun/_bun" ] && source "/home/tan/.bun/_bun"

# bun
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
# >>> PI python toolbox PATH (pi bootstrap) >>>
if [ -d "$HOME/.venv/bin" ]; then
  case ":$PATH:" in
    *":$HOME/.venv/bin:"*) :;;
    *) export PATH="$HOME/.venv/bin:$PATH";;
  esac
fi
# <<< PI python toolbox PATH (pi bootstrap) <<<

# opencode
export PATH=/home/tan/.opencode/bin:$PATH


# >>> PI_VAULT_ROOT (pi bootstrap) >>>
export PI_VAULT_ROOT="/home/tan/vault"
# <<< PI_VAULT_ROOT (pi bootstrap) <<<

# >>> PI agent bin PATH (pi bootstrap) >>>
export PATH="$HOME/.pi/agent/bin:$PATH"
# <<< PI agent bin PATH (pi bootstrap) <<<

. "$HOME/.local/bin/env"


# Added by Antigravity CLI installer
export PATH="/home/tan/.local/bin:$PATH"
