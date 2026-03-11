# Lessons

## Tooling

- On Windows PowerShell, prefer `npm.cmd` instead of `npm` because execution policies can block `npm.ps1`.

## Deployment

- If the user wants a one-click deploy script that does not touch an existing web server, keep deployment isolated to an app-level `systemd` service. Do not install, rewrite, restart, or delete `nginx` sites as part of that script.

## TypeScript

- When `exactOptionalPropertyTypes` is enabled, props that may explicitly receive `undefined` need `| undefined` in their types or conditional prop spreading.

## Product Modeling

- For business models, raw financial fields are not enough; inputs should map to user mental models such as members, employees, shareholders, scenarios, and month-level decisions.
- For operating models, “configurable” is not the same as “many fields”. The UI must reflect the real revenue engine and cost engine of the business.
- Split the product shell early. `App.tsx` should orchestrate workspace state and routing, while dashboards and input workbenches live in dedicated components.
- Version management is a workspace action, not automatically a full page. Snapshot, publish, import, and export usually belong in the top-right workspace control.
- If users think in “default month plus exceptions”, store an explicit monthly template. Do not fake that workflow by copying from a real month.
- When screen density matters, put editable defaults in the first row of the working table. Do not spend a separate card or capsule row on “default values” if the user still has to scan the table right below it.
- If users think in “scrubbing through months”, use a true rail or slider instead of a wall of month pills.
- `No horizontal scrollbar` is a product requirement, not a styling preference. Prefer responsive charts, compact controls, and alternative layouts before allowing horizontal scroll.
- For month-by-month operating inputs, fields like event cadence and sales factor should be edited as visual trajectories first and raw numbers second.
- When two monthly drivers are edited together in user thinking, merge them into one linked chart instead of stacking separate charts.
- For dense operational tables, shrinking `min-width` is not enough. Use fixed column widths, center headers, remove redundant per-cell units, and size the inputs to the real editing need.
- In side-by-side dashboard layouts, do not let one pane create fake empty space in the other. If users care about alignment, the cards need a shared visual rhythm.
- Height balance in analytics pages should come from real analytical density, not filler paragraphs.
- When a member analytics page combines a trend chart and a donut chart, keep them inside one shared analysis block and compress the donut legend. A tall one-column legend will create obvious dead space beside the line chart.
- Once per-member cards exceed one screen and repeat the same financial fields, switch to a compact table. Dense operating analysis should default to table rhythm, not stacked cards.
- If one control only affects the selected-month views, place it next to the selected-month table instead of at the top of the whole page. Do not let a month slider visually imply that it drives the long-horizon trend chart.
- In member finance tables, `member` and `employment type` are separate comparison axes. Do not nest type badges inside the member name cell if users need to scan by type.
- If a trend chart is visually the primary month navigator, make the months on the chart clickable and let the selected-month panels follow it. Do not force the user to move their cursor away to a second control for the same selection.
- If a section title already encodes the selected month, remove duplicate month badges from the same panel. Repeating the same value in the top-right wastes space and weakens hierarchy.
- For time-series charts where users compare relative changes between close values, do not anchor the Y axis at zero by default. Use an adaptive range with padding so the variation remains legible.
- In a finance breakdown panel, do not repeat the same cost story in both a detailed list and a second “cost structure” block. Once the breakdown rows already explain the stack, the extra block usually wastes height and creates visual clutter.
- In one dashboard, the primary trend chart should follow the same visual language as the rest of the analysis cards unless there is a strong semantic reason not to. A lone black chart block inside an otherwise light analytics surface usually feels disconnected.
- If the breakdown title already includes the selected month, remove repeated current-month badges from the panel header and month rail. Keep only the progression index if it still adds orientation.
- Remove dead narrative inputs when they stop serving the decision workflow. Deleting `notes` is better than hiding it behind another tab.
- In Chinese finance breakdown rows, avoid uppercase/tracking-heavy label styling and give the breakdown pane enough width before accepting label wraps. These rows are scanning aids; they should read as single-line ledger items whenever possible.
- In split analytics dashboards, reclaim width by reducing inter-panel gutters before shrinking the main chart. Users usually perceive narrow charts sooner than they perceive slightly tighter spacing.
- When a chart metric toggle only changes the chart lens, style it as a lightweight secondary control close to the chart. Do not let `cash / profit / revenue / cost` read like a top-level page navigation bar.
- A cost system is not configurable if `monthly fixed / per-event / per-unit` are stored as three scalars. Model baseline costs as editable item lists per cost driver so users can add, rename, and remove items without code changes.
- Do not label baseline business costs as `default values` in the main cost-structure editor. If the user is editing the long-term cost ledger itself, each row is a real cost item; reserve `template/default` language for month-level exception tables only.
- In dense finance editors, do not let the top summary block become a second editor. If users need the top area to understand the effect of lower edits, make it a read-only overview and move all editing controls into a separate lower work area.
- In cost dashboards with uneven information density, avoid left/right equal-height summary blocks. Stack `baseline` and `current-month impact` vertically so the overview stays compact and does not create dead space.

## Financial Domain Modeling

- In entertainment operating models, do not mix performer economics with backstage staffing. A `per-show subsidy` for staff must be modeled as employee cost, not as a performer field.
- When investment comes from multiple people, never collapse startup capital into one scalar if the user is reasoning about ownership. Model shareholders explicitly with both `investmentAmount` and `dividendRate`.
- Separate input modules by business axis, not by implementation convenience. Shareholder capital, revenue engine, and cost structure are different editing jobs.
- Project-level framing assumptions such as `start month` and `horizon` belong with the capital/setup model if the user sees them as the premise of the whole investment, not as part of monthly revenue editing.
- Revenue assumptions and monthly revenue rhythm belong in one `revenue engine` workflow when both are part of the same income judgment in the user’s head.
- Extra online / e-cut income must be a first-class monthly revenue field. Do not hide it in notes or force it into offline sales assumptions.
- If online and offline sales have different pricing, do not model online income as a raw monthly amount. Tie it back to the same offline sales engine with an explicit `online sales factor` and `online unit price`, otherwise price changes and sales-strength changes will not propagate together.
- In monthly idol-group models, member travel may be configured on a member row, but its financial driver is still `per-show cost`. Bucket costs by economic driver, not by which form owns the field.
- In financial dashboards, never label a subtotal as `totalCost`. If commissions are part of the cost stack, displayed total cost and charts must include commissions too.
- A stage-cost system is still rigid if `VJ / 推流 / 聚餐` only exist as hardcoded columns in a monthly table. Model stage costs as editable item definitions plus per-month value/count rows so the user can add new items like `团建/场` without code changes.
- For per-show optional costs, storing only `amount` is insufficient. The model also needs an explicit monthly `count` so users can express cases like “3月聚餐只算 3 场” or “3月化妆不计入”.
- Migration code should merge legacy scalar fields into new structured arrays even when transitional bundles already contain empty placeholder arrays. Otherwise old values get silently zeroed during schema upgrades.
- Do not hardcode coarse numeric `step` values on editable cost amounts. Real operating costs like `150` or `300` are valid business inputs; the UI must not mark them invalid just because the spinner was tuned to `100`.
- In month-difference cost tables, consumables should be edited as a per-unit numeric driver (`/张`), not as a boolean include switch. Users reason about `0` or `6/张`, not about abstract on/off flags.
- If a cost mode is `monthly`, do not render a fake second column like `计入`. Count-like fields should only exist for modes that genuinely repeat, such as `perEvent`.
- If a stage-cost table already has a mode selector, keep item names mode-agnostic. Labels like `VJ / 化妆 / 耗材` should stay plain; `/月 /场 /张` belongs in the type dropdown, not in the name itself.
- When migrating from a transitional cost model, only move legacy per-unit material fields into stage-cost rows if the old bundle actually used month-level material toggles or per-month material amounts. Otherwise preserve baseline `perUnitCosts` as baseline costs instead of silently reclassifying them.
- For per-unit stage costs like `耗材`, the template row should hold the baseline unit amount and month rows should edit a `0-1` inclusion factor. Users often think in “this month counts or not” rather than retyping the raw unit price every month.
- In dense monthly cost tables, `单价` and `场次` for per-event items should share one composite cell before adding more columns. Reducing column count is more valuable than giving each tiny numeric field its own header cell.
- If `按张` costs are modeled as a baseline amount plus a month coefficient, render them as the same kind of composite cell users see for `按场`: show `单价 / 系数` together instead of hiding the baseline amount in one row and the coefficient in another shape.
- Inside a dense composite cell, the secondary repeater input like `场次` should be visibly narrower than the amount input, and month-reset actions should default to icon-only buttons. Dense cost tables need horizontal space for data, not repeated chrome.
- In mixed stage-cost tables, automatically sort columns by economic driver priority (`按张 -> 按场 -> 按月`) before rendering. Users compare high-frequency variable costs first; leaving columns in creation order weakens scanability.
- In compact financial grids, native browser number spinners are layout bugs. Remove them and use tabular figures so narrow numeric inputs show the full value cleanly.
- If the top cost block only exists to show the effect of lower edits, make it a single visual summary such as a cumulative monthly chart. Do not turn the summary area into a second editing surface.
- If users already finish the real cost configuration inside month-difference tables, delete the extra baseline editor instead of inventing a parallel `long-term baseline` workflow.
- For monthly cost overviews, do not default to cumulative bars if the user needs to compare one month against another. Use independent stacked bars by cost type, and keep total labels visible above each month.
- If the user reasons about costs in leaf items like `化妆 / 推流 / 聚餐 / 耗材`, do not re-aggregate them into broad buckets in the chart. Show the leaf items directly, narrow the bars, and provide a real hover tooltip for the breakdown.
- In monthly stacked cost charts, keep the total label hugging the top of each bar and anchor the tooltip to the hovered bar instead of floating it in the middle. The tooltip should also show each item’s share of that month’s total so the stack reads as structure, not just raw amounts.
- If chart labels live outside the bars, reserve explicit vertical headroom for them in the plot area. Do not rely on overflow luck; otherwise the highest-month labels will get clipped against the chart frame.
- In dense editors with multiple tables, table-level actions like `同步默认` should live next to the table they affect, not in a shared section header. Global placement blurs ownership and wastes scan effort.
- In bar-chart dashboards, the tooltip should orbit the hovered bar from the left or right. Do not center it over the active bar; covering the user’s hover target breaks the comparison.
- If a section already has a clear parent title like `成本编辑`, do not add another wrapper heading such as `月度差异` plus extra explanatory copy. Put the tabs in the main header and let the active table be the content.
- In dense editors, if tabs are the primary mode switch, place them immediately beside the section title and move tab-specific actions into the same top row. Do not bury the action buttons inside the card body and force the user to scan downward before acting.
- Do not keep generic training-side fields like `额外每场 / 额外固定` once the same adjustments can be expressed in a dynamic stage-cost table. One editable source of truth is better than parallel knobs.
- In paired financial price inputs such as `线上单价 / 线下单价`, give both fields the same label/help height and equal-width columns. If the two prices sit in one business block, any vertical drift makes the form look broken even when the data model is correct.
- For coefficient-style finance inputs like `salesMultiplier` and `onlineSalesFactor`, round values at the state and migration layer before they hit the input. If you only rely on display formatting, users will still run into float-noise values like `1.320000052`.
- If a dashboard already has a shared `selected month` state, every month-oriented chart in that panel should publish clicks into the same state instead of keeping month selection isolated to sliders. A chart that looks selectable but does not drive the other month detail panels feels broken.
- In chart-plus-table input sections, do not repeat the workflow with extra subheadings and helper copy once the chart, table, and controls already make the interaction obvious. Redundant copy burns vertical space and weakens scanability.
- In dense numeric tables, factor columns such as `onlineSalesFactor` must use the same horizontal centering as neighboring numeric fields in both the template row and month rows. One off-axis factor column makes the whole table look broken.
- In roster-driven performance models, team members are not static across the whole horizon. If the business expects people to leave mid-cycle, model an explicit departure month and stop counting that person’s revenue, base pay, and travel after the selected month.
- For lifecycle controls like a member leaving the group, bind the field to the current planning horizon rather than a raw calendar month number. In a `3月 -> 次年2月` cycle, `做到6月` should map to the 4th operating month, not a hardcoded numeric month value.
- Never trust mojibake copied from terminal output when patching Chinese UI. If one new label renders as gibberish, replace the source string with a clean product-facing term instead of reusing the broken bytes.
- If a cycle-linked UI control renders garbled month text, inspect the upstream month-label generator and default model strings first. Fixing the local component alone will not help if its options are derived from corrupted labels.
- When default assumptions change, update both scenario tests and storage-migration tests in the same change. Old assertions around horizon length, shareholder count, and baseline revenue will otherwise produce false failures.
