#!/bin/bash

# list of config folders to replace
folders=$(ls .config/)

for f in ${folders[@]}
do
    # backup the folders in ~/.config
    if [ -d ~/.config/$f ]; then
        mv ~/.config/$f ~/.config/${f}_bak
    fi
    # make symbolic links
    ln -sf ~/.dotfiles/.config/$f/ ~/.config/$f
done
