/**
 * @module utils/compare
 * @description MCP 服务配置值的深度比较工具。
 * 用于判断服务更新时配置是否发生实质变化，从而决定是否需要重启 SSE 连接。
 */

/**
 * 判断给定值是否为普通对象（非 null、非数组、typeof === "object"）。
 *
 * @param {*} value - 待检查的值
 * @returns {boolean} 是否为普通对象
 */
function isConfigObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * 深度比较两个 MCP 服务配置值是否相等。
 * 支持基本类型、数组、普通对象的递归比较。
 *
 * @param {*} leftValue  - 左侧待比较的值
 * @param {*} rightValue - 右侧待比较的值
 * @returns {boolean} 两个值在结构上是否完全相等
 */
export function serviceConfigValuesEqual(leftValue, rightValue) {
  // 使用 Object.is 进行基本类型精确比较（包括 NaN、+0/-0）
  if (Object.is(leftValue, rightValue)) {
    return true;
  }
  // 数组类型比较：两边必须都是数组且长度一致，递归比较每个元素
  if (Array.isArray(leftValue) || Array.isArray(rightValue)) {
    // 只有一方是数组则不相等
    if (!Array.isArray(leftValue) || !Array.isArray(rightValue)) {
      return false;
    }
    // 长度不同则不相等
    if (leftValue.length !== rightValue.length) {
      return false;
    }
    // 递归比较数组每个位置的元素
    return leftValue.every((item, index) =>
      serviceConfigValuesEqual(item, rightValue[index]),
    );
  }
  // 对象类型比较：两边必须都是普通对象且键一致，递归比较每个属性值
  if (isConfigObject(leftValue) || isConfigObject(rightValue)) {
    // 只有一方是对象则不相等
    if (!isConfigObject(leftValue) || !isConfigObject(rightValue)) {
      return false;
    }
    // 排序键名后进行逐键比较
    const leftKeys = Object.keys(leftValue).sort();
    const rightKeys = Object.keys(rightValue).sort();
    // 键数量不同则不相等
    if (leftKeys.length !== rightKeys.length) {
      return false;
    }
    // 逐键比较键名和对应值
    return leftKeys.every(
      (key, index) =>
        key === rightKeys[index] &&
        serviceConfigValuesEqual(leftValue[key], rightValue[key]),
    );
  }
  // 基本类型（非 NaN）且 Object.is 不等，视为不相等
  return false;
}

/**
 * 判断更新负载中是否包含相对于现有服务的实质性配置变更。
 * 只有 command、args、url、env 等字段发生变化时才视为实质更新。
 * 仅修改 name 字段不算实质变更（不触发 SSE 重连）。
 *
 * @param {object|undefined} existingService - 当前已有的服务配置，可能不存在
 * @param {object}           updates         - 用户提交的更新字段集合
 * @returns {boolean} 是否存在实质性配置变更
 */
export function hasActualServiceUpdate(existingService, updates) {
  // 遍历更新字段中的每个键值对
  for (const [key, value] of Object.entries(updates)) {
    // name 字段变更不影响运行，跳过
    if (key === "name") {
      continue;
    }
    // 使用深度比较判断该字段的值是否发生变化
    if (!serviceConfigValuesEqual(value, existingService?.[key])) {
      return true;
    }
  }
  return false;
}
