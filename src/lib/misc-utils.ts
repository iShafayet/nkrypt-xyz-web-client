export function isObject(item) {
  return item && typeof item === "object" && !Array.isArray(item);
}

export function deepMerge(target, ...sources) {
  if (!sources.length) return target;
  const source = sources.shift();

  if (isObject(target) && isObject(source)) {
    for (const key in source) {
      if (isObject(source[key])) {
        if (!target[key]) Object.assign(target, { [key]: {} });
        deepMerge(target[key], source[key]);
      } else {
        Object.assign(target, { [key]: source[key] });
      }
    }
  }

  return deepMerge(target, ...sources);
}

export function arrayDistinct(array) {
  return array.filter((value, index, self) => {
    return self.indexOf(value) === index;
  });
}

export function sleep(timeout) {
  return new Promise((accept) => {
    setTimeout(accept, timeout);
  });
}
