import { _decorator, Component, Node, js, log } from 'cc';
import { NATIVE } from 'cc/env';
{{IMPORTS}}

const { ccclass } = _decorator;

function requireNative(name: string, nativeClass: string): void {
    const bridge = (globalThis as unknown as Record<string, unknown>)[nativeClass];
    if (bridge === undefined || bridge === null) {
        throw new Error(`[plugin-dev] ${name}: 原生类 ${nativeClass} 未注册；不能使用 JavaScript fallback 作为原生测试结果。`);
    }
    log(`[plugin-dev] ${name}: 原生类 ${nativeClass} 已注册。`);
}

function attachProbe(node: Node, name: string, exports: Record<string, unknown>): void {
    const components = Object.keys(exports).map(key => exports[key]).filter(value => typeof value === 'function' && js.isChildClassOf(value, Component));
    if (components.length !== 1) {
        throw new Error(`[plugin-dev] ${name}: runtime/PluginProbe.ts 必须导出一个 Component，实际找到 ${components.length} 个。`);
    }
    node.addComponent(components[0] as typeof Component);
    log(`[plugin-dev] ${name}: 已挂载 PluginProbe；测试结果由组件输出。`);
}

@ccclass('CocosPluginDevelopmentBootstrap')
export class CocosPluginDevelopmentBootstrap extends Component {
    start(): void {
        if (!NATIVE) throw new Error('[plugin-dev] 此场景用于 Windows 原生插件调试，请通过插件开发工作台构建并运行。');
{{REGISTRATIONS}}
{{PROBES}}
    }
}
