#!/bin/bash
sudo apt update
sudo apt install git tree wget zip cmake build-essential htop net-tools -y
sudo apt install zsh tmux curl openssh-server sshfs gpg -y
sudo apt install ffmpeg openmpi-bin openmpi-common openmpi-doc libopenmpi-dev -y
sudo apt install libevent-dev ncurses-dev bison pkg-config
# zoxide
# curl -sS https://raw.githubusercontent.com/ajeetdsouza/zoxide/main/install.sh | bash

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

