import { _decorator, Component, log } from 'cc';
import { {{CLASS}} } from './index';
const { ccclass } = _decorator;

/** Attach to any node in the current project to test TS -> JSB -> C++. */
@ccclass('{{NATIVE_CLASS}}Probe')
export class {{CLASS}}Probe extends Component {
    start(): void {
        const result = {{CLASS}}.add(20, 22);
        log(`[{{NAME}}] enabled=${{{CLASS}}.enabled}, native=${{{CLASS}}.available}, 20+22=${result}`);
        log({{CLASS}}.ping());
        if (result !== 42) throw new Error('{{NAME}} native bridge returned an unexpected value');
{{PROBE_EXTRA}}
    }
}
