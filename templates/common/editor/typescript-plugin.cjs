'use strict';

const fs = require('node:fs');
const path = require('node:path');

module.exports = function () {
    return {
        create(info) { return info.languageService; },
        getExternalFiles(project) {
            const projects = JSON.parse(fs.readFileSync(path.join(__dirname, 'projects.json'), 'utf8'));
            const name = path.resolve(project.getProjectName()).replace(/\\/g, '/').toLowerCase();
            return projects[name] ? [projects[name]] : [];
        },
    };
};
