# ~/.bash_profile
#
# Keep this file bash/POSIX-compatible. zsh-specific settings belong in ~/.zshrc.

if [ -f ~/.profile.local ]; then
    source ~/.profile.local
fi

if [ -d "$HOME/bin" ] ; then
    PATH="$HOME/bin:$PATH"
fi

# set PATH so it includes user's private bin if it exists
if [ -d "$HOME/.local/bin" ] ; then
    PATH="$HOME/.local/bin:$PATH"
fi


. "$HOME/.cargo/env"
