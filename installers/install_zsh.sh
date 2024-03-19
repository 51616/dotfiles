#!/bin/bash

# install zsh
sh -c "$(curl -fsSL https://raw.githubusercontent.com/robbyrussell/oh-my-zsh/master/tools/install.sh) --unattended"
chsh -s /usr/bin/zsh

# download 10k theme
git clone --depth=1 https://github.com/romkatv/powerlevel10k.git ~/.oh-my-zsh/themes/powerlevel10k

# download syntax-highlight theme
git clone https://github.com/catppuccin/zsh-syntax-highlighting.git
cd zsh-syntax-highlighting/themes/
cp -v catppuccin_mocha-zsh-syntax-highlighting.zsh ~/.zsh/

# download syntax-highlight theme
# mkdir -p ~/.config/fsh
# cd ~/.config/fsh
# curl -LO https://raw.githubusercontent.com/catppuccin/zsh-fsh/main/themes/catppuccin-mocha.ini
# fast-theme XDG:catppuccin-mocha
# cd -

zsh
