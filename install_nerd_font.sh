#!/bin/bash

# Install the fonts
# "AnonymousPro" "Ubuntu" "UbuntuMono" "Noto" "RobotoMono" "SourceCodePro" "Hack" "DejaVuSansMono"
fonts_to_install=("FiraCode" "FiraMono") 

git clone --sparse --depth=1 --filter=blob:none https://github.com/ryanoasis/nerd-fonts.git
cd nerd-fonts
# Add the fonts to install to the sparse-checkout
git sparse-checkout add $(printf "patched-fonts/%s " "${fonts_to_install[@]}")

./install.sh "${fonts_to_install[@]}"
rm -rf nerd-fonts
