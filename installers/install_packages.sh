#!/bin/bash
sudo apt update
sudo apt install git tree wget zip cmake build-essential htop net-tools -y
sudo apt install zsh tmux curl openssh-server sshfs -y
sudo apt install ffmpeg openmpi-bin openmpi-common openmpi-doc libopenmpi-dev -y
curl -sS https://raw.githubusercontent.com/ajeetdsouza/zoxide/main/install.sh | bash

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
python3 -m pipx install rich-cli
python3 -m pipx inject rich-cli Pygments
