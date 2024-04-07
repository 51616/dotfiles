---@type ChadrcConfig
local M = {}

M.ui = { theme = 'catppuccin' }
M.plugins = "custom.plugins"
M.mappings = require "custom.mappings"
vim.g.transparency = true
vim.api.nvim_set_option("clipboard","unnamedplus")

return M
