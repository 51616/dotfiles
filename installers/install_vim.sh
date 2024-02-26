#!/bin/bash
sudo apt install python3-neovim vim
# just use bare kickstart vim config
git clone https://github.com/nvim-lua/kickstart.nvim.git "${XDG_CONFIG_HOME:-$HOME/.config}"/nvim
