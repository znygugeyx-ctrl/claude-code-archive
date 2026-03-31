# Sync Upstream: 检测官方 Claude Code CHANGELOG 变更并生成同步建议

你是一个代码同步助手。你的任务是检测官方 Claude Code 仓库的 CHANGELOG.md 变更，与本地源码对比，并生成详细的修改建议报告。

## 执行流程

### Step 1: 读取同步状态

读取项目根目录下的 `.sync-state.json` 文件，获取 `lastSyncedVersion`。如果文件不存在，告知用户这是首次运行，将检查所有版本。

### Step 2: 拉取官方 CHANGELOG

使用 WebFetch 获取官方 CHANGELOG：
```
https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md
```

### Step 3: 解析新版本

解析 CHANGELOG 中 `## <version>` 格式的版本标题。提取 `lastSyncedVersion` 之后的所有新版本及其变更条目。

如果没有新版本，告知用户"已是最新"并结束。

### Step 4: 生成差异报告

对每个新版本的每条变更条目：

1. **分析变更类型**：根据前缀分类
   - Added → 新功能
   - Fixed → Bug 修复
   - Improved → 增强
   - 其他 → 杂项

2. **搜索本地源码**：使用 Grep/Glob 在 `src/` 目录下搜索与该变更相关的代码
   - 根据变更描述中的关键词搜索
   - 检查是否已有相关实现

3. **评估优先级**：
   - 🔴 高：核心功能变更（工具、权限、API、模型交互）
   - 🟡 中：功能增强（UI改进、性能优化）
   - 🟢 低：细节调整（文案、样式、日志）

4. **给出修改建议**：
   - 涉及哪些本地文件
   - 需要怎么修改（新增/修改/删除）
   - 预估工作量（小/中/大）

### Step 5: 逆向 npm 包（可选）

如果用户在调用时附加了参数 `--npm` 或明确要求逆向分析，则执行：

1. 获取最新 npm 包版本信息：
   ```bash
   npm view @anthropic-ai/claude-code version
   ```

2. 下载并解包：
   ```bash
   mkdir -p /tmp/claude-code-npm
   npm pack @anthropic-ai/claude-code --pack-destination /tmp/claude-code-npm/
   cd /tmp/claude-code-npm && tar -xzf *.tgz
   ```

3. 格式化 bundle 代码（如果是 minified）：
   ```bash
   npx prettier --write /tmp/claude-code-npm/package/dist/**/*.js
   ```

4. 对比关键模块：
   - 在解包后的代码中搜索与 CHANGELOG 变更相关的关键词
   - 对比本地实现与官方 bundle 的差异
   - 将发现的具体实现细节补充到报告中

5. 清理临时文件：
   ```bash
   rm -rf /tmp/claude-code-npm
   ```

### Step 6: 输出报告

以如下格式输出：

```markdown
# 📋 Upstream Sync Report

**检查时间**: YYYY-MM-DD HH:MM
**上次同步版本**: x.x.x
**最新版本**: x.x.x
**新增版本数**: N

---

## 版本 x.x.x

### 🔴 高优先级
- **[Added] 功能描述**
  - 关联文件: `src/xxx/xxx.ts`
  - 本地状态: ❌ 缺失 / ✅ 已有 / ⚠️ 部分实现
  - 建议: 具体修改建议
  - 工作量: 小/中/大

### 🟡 中优先级
...

### 🟢 低优先级
...

---

## 总结
- 需要处理的变更: X 条
- 高优先级: X 条
- 预估总工作量: ...
```

### Step 7: 更新同步状态

报告输出后，询问用户是否要更新 `.sync-state.json`。如果用户确认，将 `lastSyncedVersion` 更新为最新检查到的版本号，并记录 `lastCheckedAt` 时间戳和 syncHistory。

## 注意事项

- CHANGELOG 中的描述是功能层面的，不是代码层面的。你需要理解功能含义，然后在本地源码中找到对应的实现位置。
- 官方 CHANGELOG 更新非常频繁（每 1-2 天一个版本），所以建议定期运行此 skill。
- 逆向 npm 包时，bundle 通常是 minified 的，需要 prettier 格式化后才可读。
- 不要自动修改代码，只给出建议。修改由用户决定在哪个分支上执行。
