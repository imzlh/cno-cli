module.exports.otherMethod = function () {
    return 1;
};

module.exports.getValue = function () {
    return this.otherMethod();
};
