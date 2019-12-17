import * as ts from 'typescript';
import * as fs from 'fs';
import * as path from 'path';
import cssPropTransformer from '../index';
import pkg from '../../../../package.json';

jest.mock('../../utils/identifiers');

const printer = ts.createPrinter();

/**
 * This creates a full project which will resolve all modules.
 * Only use this when wanting to test imports tbh. It's slow.
 */
const fullTransform = (...sources: string[]): Promise<string> => {
  return new Promise((resolve, reject) => {
    try {
      fs.rmdirSync(`${__dirname}/.tmp`, { recursive: true });
    } catch {}

    fs.mkdirSync(`${__dirname}/.tmp`);
    const files: string[] = [];
    sources.forEach((source, index) => {
      const filename = index === 0 ? 'index.tsx' : `${index}.tsx`;
      const filepath = path.resolve(`${__dirname}/.tmp/${filename}`);
      files.push(filepath);
      fs.writeFileSync(filepath, source);
    });

    const [rootFile] = files;
    const config: ts.CompilerOptions = {
      jsx: ts.JsxEmit.Preserve,
      module: ts.ModuleKind.ESNext,
      suppressImplicitAnyIndexErrors: true,
      target: ts.ScriptTarget.ESNext,
      // Uncomment this if shit isn't working.
      // noEmitOnError: true,
    };
    const compilerHost = ts.createCompilerHost(config, true);
    const program = ts.createProgram([rootFile], config, compilerHost);

    const { emitSkipped, diagnostics, emittedFiles } = program.emit(
      undefined,
      (filename, data) => {
        if (filename.endsWith('index.jsx')) {
          resolve(data);
        }
      },
      undefined,
      false,
      {
        before: [cssPropTransformer(program)],
      }
    );

    if (emitSkipped) {
      return reject(new Error(diagnostics.map(diagnostic => diagnostic.messageText).join('\n')));
    }

    if (!emittedFiles) {
      return reject(new Error('Nothing was emitted'));
    }
  });
};

const transform = (source: string): string => {
  const transformer = cssPropTransformer({} as any);
  const sourceFile = ts.createSourceFile('index.tsx', source, ts.ScriptTarget.Latest);
  const actual = ts.transform(sourceFile, [transformer]).transformed[0];
  return printer.printFile(actual).toString();
};

describe('css prop transformer', () => {
  it('should replace css prop with class name', () => {
    const actual = transform(`
      /** @jsx jsx */
      import { jsx } from '${pkg.name}';

      <div css={{}}>hello world</div>
    `);

    expect(actual).toInclude('<div className="test-class">hello world</div>');
  });

  it('should add react default import if missing', () => {
    const actual = transform(`
      /** @jsx jsx */
      import { jsx } from '${pkg.name}';

      <div css={{}}>hello world</div>
    `);

    expect(actual).toInclude('import React from "react";');
  });

  it('should do nothing if react default import is already defined', () => {
    const actual = transform(`
      /** @jsx jsx */
      import React from 'react';
      import { jsx } from '${pkg.name}';

      <div css={{}}>hello world</div>
    `);

    expect(actual).toIncludeRepeated('import React from "react";', 1);
  });

  it('should add react default import if it only has named imports', () => {
    const actual = transform(`
      /** @jsx jsx */
      import { useState } from 'react';
      import { jsx } from '${pkg.name}';

      <div css={{}}>hello world</div>
    `);

    expect(actual).toIncludeRepeated('import React from "react";', 1);
    expect(actual).toIncludeRepeated('import { useState } from "react";', 1);
  });

  it.todo('should concat explicit use of class name prop on an element');

  it.todo('should concat implicit use of class name prop where props are spread into an element');

  it.todo('should concat use of inline styles when there is use of dynamic css');

  describe('using strings', () => {
    it('should transform string literal', () => {
      const actual = transform(`
        /** @jsx jsx */
        import { jsx } from '${pkg.name}';

        <div css="font-size: 20px;">hello world</div>
    `);

      expect(actual).toInclude('<style>.test-class{font-size:20px;}</style>');
    });

    it('should transform no template string literal', () => {
      const actual = transform(`
        /** @jsx jsx */
        import { jsx } from '${pkg.name}';

        <div css={\`font-size: 20px;\`}>hello world</div>
    `);

      expect(actual).toInclude('<style>.test-class{font-size:20px;}</style>');
    });

    it('should transform template string literal with string variable', () => {
      const actual = transform(`
          /** @jsx jsx */
          import { jsx } from '${pkg.name}';

          const color = 'blue';
          <div css={\`color: \${color};\`}>hello world</div>
      `);

      expect(actual).toInclude('<style>.test-class{color:var(--color-test-css-variable);}</style>');
      expect(actual).toInclude(
        '<div className="test-class" style={{ "--color-test-css-variable": color }}>hello world</div>'
      );
    });

    it.todo('should transform template string literal with string import');

    it.todo('should transform template string literal with obj variable');

    it.todo('should transform template string literal with obj import');

    it.todo('should transform template string literal with array variable');

    it.todo('should transform template string literal with array import');

    it.todo('should transform template string with no argument arrow function variable');

    it.todo('should transform template string with no argument arrow function import');

    it.todo('should transform template string with no argument function variable');

    it.todo('should transform template string with no argument function import');

    it.todo('should transform template string with argument function variable');

    it.todo('should transform template string with argument function import');

    it.todo('should transform template string with argument arrow function variable');

    it.todo('should transform template string with argument arrow function import');
  });

  describe('using an object literal', () => {
    it('should transform object with simple values', () => {
      const actual = transform(`
        /** @jsx jsx */
        import { jsx } from '${pkg.name}';

        <div css={{ fontSize: 20, color: 'blue' }}>hello world</div>
      `);

      expect(actual).toInclude('<style>.test-class{font-size:20;color:blue;}</style>');
    });

    it('should transform object with nested object into a selector', () => {
      const actual = transform(`
        /** @jsx jsx */
        import { jsx } from '${pkg.name}';

        <div css={{ ':hover': { color: 'blue' } }}>hello world</div>
      `);

      expect(actual).toInclude('<style>.test-class:hover{color:blue;}</style>');
    });

    it('should transform object with object selector from variable', async () => {
      const actual = await fullTransform(
        `
        /** @jsx jsx */
        import { jsx } from '${pkg.name}';
        import { mixin } from './1';

        <div css={{ ':hover': mixin }}>hello world</div>
      `,
        `
        export const mixin = { color: 'blue' };
      `
      );

      expect(actual).toInclude('<style>.test-class:hover{color:blue;}</style>');
    });

    it.todo('should transform object with object selector from import');

    it('should transform object that has a variable reference', () => {
      const actual = transform(`
        /** @jsx jsx */
        import { jsx } from '${pkg.name}';

        const blue = 'blue';
        <div css={{ color: blue }}>hello world</div>
      `);

      expect(actual).toInclude(
        '<div className="test-class" style={{ "--color-test-css-variable": blue }}>hello world</div>'
      );
      expect(actual).toInclude('<style>.test-class{color:var(--color-test-css-variable);}</style>');
    });

    it('should transform object that has a destructured variable reference', () => {
      const actual = transform(`
        /** @jsx jsx */
        import { useState } from 'react';
        import { jsx } from '${pkg.name}';

        const [color, setColor] = useState('blue');
        <div css={{ color }}>hello world</div>
      `);

      expect(actual).toInclude(
        '<div className="test-class" style={{ "--color-test-css-variable": color }}>hello world</div>'
      );
      expect(actual).toInclude('<style>.test-class{color:var(--color-test-css-variable);}</style>');
    });

    it('should transform object spread from variable', () => {
      const actual = transform(`
        /** @jsx jsx */
        import { jsx } from '${pkg.name}';

        const mixin = { color: 'red' };
        <div css={{ color: 'blue', ...mixin }}>hello world</div>
      `);

      expect(actual).toInclude('<style>.test-class{color:blue;color:red;}</style>');
    });

    it.todo('should transform object spread from import');

    it.todo('should transform object with string variable');

    it.todo('should transform object with string import');

    it.todo('should transform object with obj variable');

    it.todo('should transform object with obj import');

    it.todo('should transform object with array variable');

    it.todo('should transform object with array import');

    it('should transform object with no argument arrow function variable', () => {
      const actual = transform(`
        /** @jsx jsx */
        import { jsx } from '${pkg.name}';

        const mixin = () => ({ color: 'red' });

        <div css={{ color: 'blue', ...mixin() }}>hello world</div>
      `);

      expect(actual).toInclude('<style>.test-class{color:blue;color:red;}</style>');
    });

    it.todo('should transform object with no argument arrow function import');

    it.todo('should transform object with no argument function variable');

    it.todo('should transform object with no argument function import');

    it.todo('should transform object with argument function variable');

    it.todo('should transform object with argument function import');

    it.todo('should transform object with argument arrow function variable');

    it.todo('should transform object with argument arrow function import');
  });
});