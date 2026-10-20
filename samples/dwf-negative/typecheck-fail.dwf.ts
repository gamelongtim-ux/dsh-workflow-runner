// 故意写坏的 TypeScript：这份脚本**不应该**编译通过。
//
// 它住在 samples/dwf-negative/ 而不是 samples/dwf/，因为 samples/dwf/ 里的每一个文件
// 都必须编译通过（node scripts/dwf-samples-check.mjs 会把那里全部编译一遍）。
// 负样本的职责正好相反：它要**编译不过**，并把每一条诊断的位置与原因说清楚。
//
// 下面是旧 sample 里那几处故意写坏的地方，标注了它们应当触发的诊断码。

// TS1184 —— `declare` 在工作流脚本里非法：脚本被编译进一个函数体，
// ambient 声明在那里不成立。编译期把这条消息改写成了带修法的版本。
declare interface Shape {
  title: string;
}

// TS2322 —— 类型不匹配。
const n: number = "this is a string, not a number";

// TS2322 —— 数组元素类型不匹配。
const arr: string[] = [1, 2, 3];

// TS2304 —— 不存在的名字。
const missing = doesNotExist;

log(`n=${n} arr=${arr.join(",")} missing=${missing}`);
