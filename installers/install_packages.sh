#!/bin/bash
sudo apt update
sudo apt install git tree wget zip cmake build-essential htop net-tools -y
sudo apt install zsh tmux curl openssh-server sshfs gpg jq -y
sudo apt install ffmpeg openmpi-bin openmpi-common openmpi-doc libopenmpi-dev -y
sudo apt install libevent-dev ncurses-dev bison pkg-config -y
# zoxide
# curl -sS https://raw.githubusercontent.com/ajeetdsouza/zoxide/main/install.sh | bash

# git clone https://github.com/tmux-plugins/tpm ~/.tmux/plugins/tpm

# fzf
git clone --depth 1 https://github.com/junegunn/fzf.git ~/.fzf
~/.fzf/uninstall
~/.fzf/install

# eza
sudo mkdir -p /etc/apt/keyrings
wget -qO- https://raw.githubusercontent.com/eza-community/eza/main/deb.asc | sudo gpg --dearmor -o /etc/apt/keyrings/gierens.gpg
echo "deb [signed-by=/etc/apt/keyrings/gierens.gpg] http://deb.gierens.de stable main" | sudo tee /etc/apt/sources.list.d/gierens.list
sudo chmod 644 /etc/apt/keyrings/gierens.gpg /etc/apt/sources.list.d/gierens.list
sudo apt update
sudo apt install -y eza

# bat
sudo apt install bat
mkdir -p ~/.local/bin
ln -s /usr/bin/batcat ~/.local/bin/bat

# theme fot bat
mkdir -p "$(bat --config-dir)/themes"
wget -P "$(bat --config-dir)/themes" https://github.com/catppuccin/bat/raw/main/themes/Catppuccin%20Mocha.tmTheme
bat cache --build

# delta
# get the .deb latest release
curl -s https://api.github.com/repos/dandavison/delta/releases/latest \
| grep "browser_download_url.*musl.*amd.*.*deb" \
| cut -d : -f 2,3 | tr -d \" | wget -qi -
sudo dpkg -i git-delta*.deb

# clone theme for delta
# the theme config is set in .gitconfig
git clone https://github.com/catppuccin/delta.git ~/delta

# pipx and rich-cli
# for ubuntu 18
# sudo apt-get install python3.8 python3-pip python3.8-venv -y
# python3.8 -m pip install --user pipx
# python3.8 -m pipx ensurepath
# python3.8 -m pipx install rich-cli
# python3.8 -m pipx inject rich-cli Pygments

# for ubuntu 20-22
python3 -m pip install --user pipx
python3 -m pipx ensurepath
pipx install rich-cli
# pipx inject rich-cli Pygments
pipx install gdown
pipx install tldr

