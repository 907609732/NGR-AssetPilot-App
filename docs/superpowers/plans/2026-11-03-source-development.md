# Source Development Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 修改后双击打开最新源码开发版，发布时才打包。

**Architecture:** 复用 npm dev 和现有 esbuild/Electron，新增显式开发重启请求并沿用保存退出协调器。

**Tech Stack:** Node.js >=22.13.0、Electron、Windows cmd、现有 Playwright。

**Spec:** ../specs/2026-11-03-source-development-design.md

## Global Constraints

- 仅修改已确认的 v3.0.23 工作树；不修改旧工作区。
- 不改变业务功能或正式版行为；不新增依赖，不打包或公开发布。
- 开发资料继续与正式版隔离，不自动杀进程或自动监视重启。

## Review Focus

- 同目录连点不产生多个 relaunch。
- 正式版、测试版、异目录和无标记请求不得重启。
- 后台保存/清理继续执行；初始化中请求不打断启动。
- 路径包含空格和中文仍可双击启动，构建失败不关闭旧实例。
- 快捷方式与文档明确区分源码验证和安装包验收。

## Task 1: 开发入口和安全重启

- [x] 为重启去重、模式与目录边界增加测试，先确认失败。
- [x] 新增 desktop/main/development-restart.mjs，接入 bootstrap 的 second-instance 与初始化完成点。
- [x] 新增 npm start 和中文 cmd；缺失环境显示可执行补救命令。
- [x] 更新 README 开发流程，创建桌面快捷方式。
- [x] 跑重启单元测试、串行源码/托盘/打包配置检查和真实进程重启验收。
- [x] 独立评审变更并记录结果；只提交本次文件，推送触发日常 CI，不触发发布打包。

## Execution record

- 基线：源码 Dev/Test 和打包配置 12 项通过；并行运行时托盘焦点 1 项失败，改用仓库规定的串行执行复查，不修改托盘实现。

- 验收：新增边界测试及源码/托盘/打包配置 17 项全过；完整 npm test 为 243 通过、0 失败、1 项打包条件跳过。
- 真实 npm start 验收：主进程 PID 交接成功、localStorage 测试资料保留；桌面快捷方式实启通过。
- Windows cmd UTF-8 文件需 CRLF，已真实启动验证并在 .gitattributes 固定。
- 独立代码评审无 P1/P2 问题；未生成安装包、未安装或公开发布。

