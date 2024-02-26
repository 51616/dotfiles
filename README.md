# Dotfiles

with chezmoi
```
cd ~
echo 'mode = "symlink"' > ~/.config/chezmoi/chezmoi.toml
sh -c "$(curl -fsLS get.chezmoi.io/lb)" -- init --apply 51616
```

install the rest
```
chezmoi cd
. installers/install.sh
```
