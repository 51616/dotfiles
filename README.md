# Dotfiles

with chezmoi
```
cd ~
echo 'mode = "symlink"\n[edit]\n    watch = true\n' > ~/.config/chezmoi/chezmoi.toml
sh -c "$(curl -fsLS get.chezmoi.io/lb)" -- init --apply 51616
```

install the rest
```
chezmoi cd
. installers/install.sh
```

see also

- https://www.warp.dev/
- https://github.com/catppuccin/warp
- https://github.com/catppuccin/cursors
- https://github.com/catppuccin/firefox
- https://github.com/catppuccin/userstyles (e.g., github, google) 
- https://github.com/catppuccin/grub
- https://github.com/catppuccin/xed
- https://github.com/catppuccin/gedit

gtk themes + icons

- https://github.com/ljmill/catppuccin-icons/releases/
- https://www.xfce-look.org/p/1715554/

system font

- droid sans fallback

