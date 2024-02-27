#!/bin/bash
wget https://repo.anaconda.com/miniconda/Miniconda3-latest-Linux-x86_64.sh
bash Miniconda3-latest-Linux-x86_64.sh
source ~/.bashrc
conda update -n base conda
conda install -n base python=3.9
conda install -n base conda-libmamba-solver
conda config --set solver libmamba
