'use strict'

const child_process = require('child_process');

const networkTypes = ['Ethernet', 'Thunderbolt Ethernet', 'Wi-Fi'];

function execSync(cmd) {
    let stdout,
        status = 0;
    try {
        stdout = child_process.execSync(cmd);
    } catch (err) {
        stdout = err.stdout;
        status = err.status;
    }

    return {
        stdout: stdout.toString(),
        status
    };
}

/**
 * CentOS 的代理设置
 * ------------------------------------------------------------------------
 *
 * 文件: ~/.bash_profile
 *
 * http_proxy=http://proxy_server_address:port
 * export no_proxy=localhost,127.0.0.1,192.168.0.34
 * export http_proxy
 * ------------------------------------------------------------------------
 */

/**
 * Ubuntu 的代理设置
 * ------------------------------------------------------------------------
 *
 * 文件: /etc/environment
 * 更多信息: http://askubuntu.com/questions/150210/how-do-i-set-systemwide-proxy-servers-in-xubuntu-lubuntu-or-ubuntu-studio
 *
 * http_proxy=http://proxy_server_address:port
 * export no_proxy=localhost,127.0.0.1,192.168.0.34
 * export http_proxy
 * ------------------------------------------------------------------------
 */

/**
 * ------------------------------------------------------------------------
 * Mac 代理管理器
 * ------------------------------------------------------------------------
 */

const macProxyManager = {};

macProxyManager.getNetworkType = () => {
    for (let i = 0; i < networkTypes.length; i++) {
        const type = networkTypes[i],
            result = execSync('networksetup -getwebproxy ' + type);

        if (result.status === 0) {
            macProxyManager.networkType = type;
            return type;
        }
    }

    throw new Error('未知的网络类型');
};


macProxyManager.enableGlobalProxy = (ip, port, proxyType) => {
    if (!ip || !port) {
        console.log('设置全局代理服务器失败。\n需要提供 IP 和端口。');
        return;
    }

    proxyType = proxyType || 'http';

    const networkType = macProxyManager.networkType || macProxyManager.getNetworkType();

    return /^http$/i.test(proxyType) ?

        // 设置 HTTP 代理
        execSync(
            'networksetup -setwebproxy ${networkType} ${ip} ${port} && networksetup -setproxybypassdomains ${networkType} 127.0.0.1 localhost'
                .replace(/\${networkType}/g, networkType)
                .replace('${ip}', ip)
                .replace('${port}', port)) :

        // 设置 HTTPS 代理
        execSync('networksetup -setsecurewebproxy ${networkType} ${ip} ${port} && networksetup -setproxybypassdomains ${networkType} 127.0.0.1 localhost'
            .replace(/\${networkType}/g, networkType)
            .replace('${ip}', ip)
            .replace('${port}', port));
};

macProxyManager.disableGlobalProxy = (proxyType) => {
    proxyType = proxyType || 'http';
    const networkType = macProxyManager.networkType || macProxyManager.getNetworkType();
    return /^http$/i.test(proxyType) ?

        // 禁用 HTTP 代理
        execSync(
            'networksetup -setwebproxystate ${networkType} off'
                .replace('${networkType}', networkType)) :

        // 禁用 HTTPS 代理
        execSync(
            'networksetup -setsecurewebproxystate ${networkType} off'
                .replace('${networkType}', networkType));
};

macProxyManager.getProxyState = () => {
    const networkType = macProxyManager.networkType || macProxyManager.getNetworkType();
    const result = execSync('networksetup -getwebproxy ${networkType}'.replace('${networkType}', networkType));

    return result;
};

/**
 * ------------------------------------------------------------------------
 * Windows 代理管理器
 *
 * netsh 不会改变 IE 的设置
 * ------------------------------------------------------------------------
 */

const winProxyManager = {};

winProxyManager.enableGlobalProxy = (ip, port) => {
    if (!ip && !port) {
        console.log('设置全局代理服务器失败。\n需要提供 IP 和端口。');
        return;
    }

    return execSync(
        // 设置代理
        'reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer /t REG_SZ /d ${ip}:${port} /f & '
            .replace('${ip}', ip)
            .replace('${port}', port) +

        // 启用代理
        'reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable /t REG_DWORD /d 1 /f');
};

winProxyManager.disableGlobalProxy = () => execSync('reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable /t REG_DWORD /d 0 /f');

winProxyManager.getProxyState = () => ''

winProxyManager.getNetworkType = () => ''

module.exports = /^win/.test(process.platform) ? winProxyManager : macProxyManager;
