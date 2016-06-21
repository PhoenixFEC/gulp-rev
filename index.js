'use strict';
var path = require('path');
var gutil = require('gulp-util');
var through = require('through2');
var objectAssign = require('object-assign');
var file = require('vinyl-file');
var revHash = require('rev-hash');
var revPath = require('rev-path');
var sortKeys = require('sort-keys');
var modifyFilename = require('modify-filename');
var fs = require('fs');

function relPath(base, filePath) {
  if (filePath.indexOf(base) !== 0) {
    return filePath.replace(/\\/g, '/');
  }

  var newPath = filePath.substr(base.length).replace(/\\/g, '/');

  if (newPath[0] === '/') {
    return newPath.substr(1);
  }

  return newPath;
}

function getManifestFile(opts, cb) {
  file.read(opts.path, opts, function (err, manifest) {
    if (err) {
      // not found
      if (err.code === 'ENOENT') {
        cb(null, new gutil.File(opts));
      } else {
        cb(err);
      }

      return;
    }

    cb(null, manifest);
  });
}

function transformFilename(file) {
  // save the old path for later
  file.revOrigPath = file.path;
  file.revOrigBase = file.base;
  file.revHash = revHash(file.contents);

  file.path = modifyFilename(file.path, function (filename, extension) {
    var extIndex = filename.indexOf('.');

    filename = extIndex === -1 ?
      revPath(filename, file.revHash) :
      revPath(filename.slice(0, extIndex), file.revHash) + filename.slice(extIndex);

    return filename + extension;
  });
}

var plugin = function () {
  var sourcemaps = [];
  var pathMap = {};

  return through.obj(function (file, enc, cb) {
    if (file.isNull()) {
      cb(null, file);
      return;
    }

    if (file.isStream()) {
      cb(new gutil.PluginError('gulp-rev', 'Streaming not supported'));
      return;
    }

    // this is a sourcemap, hold until the end
    if (path.extname(file.path) === '.map') {
      sourcemaps.push(file);
      cb();
      return;
    }

    var oldPath = file.path;
    transformFilename(file);
    pathMap[oldPath] = file.revHash;

    cb(null, file);
  }, function (cb) {
    sourcemaps.forEach(function (file) {
      var reverseFilename;

      // attempt to parse the sourcemap's JSON to get the reverse filename
      try {
        reverseFilename = JSON.parse(file.contents.toString()).file;
      } catch (err) {}

      if (!reverseFilename) {
        reverseFilename = path.relative(path.dirname(file.path), path.basename(file.path, '.map'));
      }

      if (pathMap[reverseFilename]) {
        // save the old path for later
        file.revOrigPath = file.path;
        file.revOrigBase = file.base;

        var hash = pathMap[reverseFilename];
        file.path = revPath(file.path.replace(/\.map$/, ''), hash) + '.map';
      } else {
        transformFilename(file);
      }

      this.push(file);
    }, this);

    cb();
  });
};


// Update: 2016.6.20
// apply new options：
//      @param {Path} opts.rootDir (required) root directory
//      @param {String} opts.cdnAssetsPath cdn public path, e.g: http://s.abc.com/
plugin.manifest = function (pth, opts) {
  if (typeof pth === 'string') {
    pth = {path: pth};
  }

  opts = objectAssign({
    path: 'rev-manifest.json',
    merge: false,
    // Apply the default JSON transformer.
    // The user can pass in his on transformer if he wants. The only requirement is that it should
    // support 'parse' and 'stringify' methods.
    transformer: JSON,
  }, opts, pth);

  var manifest = {};

  return through.obj(function (file, enc, cb) {
    // ignore all non-rev'd files
    if (!file.path || !file.revOrigPath) {
      cb();
      return;
    }
    var revisionedFile = relPath(file.base, file.path);
    var originalFile = path.join(path.dirname(revisionedFile), path.basename(file.revOrigPath)).replace(/\\/g, '/');


    // =====================================
    // added: change manifest Key & Value.
    // ----------------------
    var curPaths = {};
    if(!!opts.rootDir && typeof opts.rootDir === 'string') {
      fs.stat(path.join(opts.rootDir), function(err, stats) {
        var curFilePathSep = path.relative(opts.rootDir, file.path).split(path.sep);
        if(!stats || !stats.isDirectory()) new gutil.PluginError('gulp-rev', '"rootDir" is not valid Directory.');
          // curFilePathSep = path.relative(opts.rootDir, file.path).split(path.sep);
        curPaths.absPath = (!!opts.cdnAssetsPath && new RegExp('http:\\/\\/').test(opts.cdnAssetsPath))
         ? path.join(opts.cdnAssetsPath, curFilePathSep.join('/'))
         : path.join('/', opts.cdnAssetsPath, curFilePathSep.join('/'));
        curPaths.relativePath = path.join(path.relative(opts.rootDir, path.dirname(file.path)), path.basename(file.revOrigPath));

        manifest[curPaths.relativePath] = curPaths.absPath;
      });
      cb();
      return;
    }



    manifest[originalFile] = revisionedFile;
    cb();
  }, function (cb) {
    // no need to write a manifest file if there's nothing to manifest
    if (Object.keys(manifest).length === 0) {
      cb();
      return;
    }

    getManifestFile(opts, function (err, manifestFile) {
      if (err) {
        cb(err);
        return;
      }

      if (opts.merge && !manifestFile.isNull()) {
        var oldManifest = {};

        try {
          oldManifest = opts.transformer.parse(manifestFile.contents.toString());
        } catch (err) {}

        manifest = objectAssign(oldManifest, manifest);
      }

      manifestFile.contents = new Buffer(opts.transformer.stringify(sortKeys(manifest), null, '  '));
      this.push(manifestFile);
      cb();
    }.bind(this));
  });
};

module.exports = plugin;
