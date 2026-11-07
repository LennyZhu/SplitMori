SplitMori Phase 3B7B · V3.2 黑白极简高保真 UI（用户已确认）

建议放置路径：SplitMori/docs/ui/

文件清单：
- SplitMori_Phase3B7B_V3_2_Design_Board.png：五屏总览
- SplitMori_3B7B_01.png：费用详情（退款入口）
- SplitMori_3B7B_02.png：登记商家退款
- SplitMori_3B7B_03.png：退款影响预览
- SplitMori_3B7B_04.png：退款历史
- SplitMori_3B7B_05.png：退款作废确认

开发使用约定：
1. 图片是已确认的视觉参考，不是业务代码或真实数据来源。
2. 财务逻辑、Free/Pro 权益及权限以冻结 PRD、Decisions、ADR 与已有 Finance Repository 为准。
3. 样例：晚餐 HKD 560，四人各负担 HKD 140；商家退款 HKD 200 实际接收人 a，四人各减免 HKD 50；活动有效费用 HKD 1,120 → HKD 920，待结算 HKD 700 → HKD 550，净额 a 应收 550、b 应付 370、Chris 应付 90、d 应付 90。
4. 作废后账务恢复为退款前，原退款事件与历史保留。真实金额必须来自 SQLite 财务服务。
5. 不要让 Codex 自行执行 iOS Simulator/真机或 git add/commit/push/merge；用户人工验收后自行提交。
