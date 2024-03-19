#!/bin/bash
mkdir -p ~/.local/share/xfce4/terminal/colorschemes
cd ~/.local/share/xfce4/terminal/colorschemes/
git clone https://github.com/catppuccin/xfce4-terminal.git
mv xfce4-terminal/src/* .
rm -rf xfce4-terminal

