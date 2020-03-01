#!/bin/bash

sh ~/.dotfiles/install_font.sh FiraCode FiraMono

#sublime settings
mkdir -p ~/.config/sublime-text-3/Packages/User/
cp ~/.dotfiles/subl_conf/* ~/.config/sublime-text-3/Packages/User/

