#!/bin/bash
sudo apt update
sudo apt install git tree wget zip cmake build-essential htop net-tools -y
sudo apt install zsh tmux curl openssh-server sshfs -y
sudo apt install ffmpeg openmpi-bin openmpi-common openmpi-doc libopenmpi-dev -y
curl -sS https://raw.githubusercontent.com/ajeetdsouza/zoxide/main/install.sh | bash

# pipx and rich-cli
python3 -m pip install --user pipx
python3 -m pipx ensurepath
python3 -m pipx install rich-cli
python3 -m pipx inject rich-cli Pygments
