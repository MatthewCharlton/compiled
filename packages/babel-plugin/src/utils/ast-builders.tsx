import template from '@babel/template';
import * as t from '@babel/types';
import traverse, { NodePath, Visitor } from '@babel/traverse';
import { unique } from '@compiled/utils';
import { transformCss } from '@compiled/css';
import isPropValid from '@emotion/is-prop-valid';
import { Tag } from '../types';
import { CSSOutput } from './css-builders';
import { pickFunctionBody } from './ast';
import { Metadata } from '../types';

export interface StyledTemplateOpts {
  /**
   * Class to be used for the CSS selector.
   */
  classNames: string[];

  /**
   * Tag for the Styled Component, for example "div" or user defined component.
   */
  tag: Tag;

  /**
   * CSS variables to be passed to the `style` prop.
   */
  variables: CSSOutput['variables'];

  /**
   * CSS sheets to be passed to the `CS` component.
   */
  sheets: string[];
}

/**
 * Hoists a sheet to the top of the module if its not already there.
 * Returns the referencing identifier.
 *
 * @param sheet Stylesheet
 * @param meta Plugin metadata
 */
const hoistSheet = (sheet: string, meta: Metadata): t.Identifier => {
  if (meta.state.sheets[sheet]) {
    return meta.state.sheets[sheet];
  }

  const sheetIdentifier = meta.parentPath.scope.generateUidIdentifier('');
  const parent = meta.parentPath.findParent((path) => path.isProgram()).get('body') as NodePath[];
  const path = parent.filter((path) => !path.isImportDeclaration())[0];

  path.insertBefore(
    t.variableDeclaration('const', [t.variableDeclarator(sheetIdentifier, t.stringLiteral(sheet))])
  );

  meta.state.sheets[sheet] = sheetIdentifier;

  return sheetIdentifier;
};

/**
 * Will build up the CSS variables prop to be placed as inline styles.
 *
 * @param variables CSS variables that will be placed in the AST
 * @param transform Transform function that can be used to change the CSS variable expression
 */
const buildCssVariablesProp = (
  variables: CSSOutput['variables'],
  transform = (expression: t.Expression) => expression
): (t.ObjectProperty | t.SpreadElement)[] => {
  return unique(
    // Make sure all defined CSS variables are unique
    variables,
    // We consider their uniqueness based on their name
    (item) => item.name
  ).map((variable) => {
    // Map them into object properties.
    return t.objectProperty(
      t.stringLiteral(variable.name),
      // Allow callers to transform the expression if needed,
      // for example the styled API strips away the arrow function.
      transform(variable.expression)
    );
  });
};

/**
 * Builds up the inline style prop value for a Styled Component.
 *
 * @param variables CSS variables that will be placed in the AST
 * @param transform Transform callback function that can be used to change the CSS variable expression
 */
const styledStyleProp = (
  variables: CSSOutput['variables'],
  transform?: (expression: t.Expression) => t.Expression
) => {
  const props: (t.ObjectProperty | t.SpreadElement)[] = [t.spreadElement(t.identifier('style'))];
  return t.objectExpression(props.concat(buildCssVariablesProp(variables, transform)));
};

/**
 * Returns a tag string in the form of an identifier or string literal.
 *
 * A type of InBuiltComponent will return a string literal,
 * otherwise an identifier string will be returned.
 *
 * @param tag Made of name and type.
 */
const buildComponentTag = ({ name, type }: Tag) => {
  return type === 'InBuiltComponent' ? `"${name}"` : name;
};

/**
 * Traverses an arrow function and then finally return the arrow function body node.
 *
 * @param node Array function node
 * @param nestedVisitor Visitor callback function
 */
const traverseStyledArrowFunctionExpression = (
  node: t.ArrowFunctionExpression,
  nestedVisitor: Visitor
) => {
  traverse(node, nestedVisitor);

  return pickFunctionBody(node);
};

/**
 * Traverses a binary expression looking for any arrow functions,
 * calls back with each arrow function node into the passed in `nestedVisitor`,
 * and then finally replaces each found arrow function node with its body.
 *
 * @param node Binary expression node
 * @param nestedVisitor Visitor callback function
 */
const traverseStyledBinaryExpression = (node: t.BinaryExpression, nestedVisitor: Visitor) => {
  traverse(node, {
    noScope: true,
    ArrowFunctionExpression(path) {
      path.traverse(nestedVisitor);
      path.replaceWith(pickFunctionBody(path.node));
      path.stop();
    },
  });

  return node;
};

/**
 * Will return a generated AST for a Styled Component.
 *
 * @param opts Template options
 * @param meta Plugin metadata
 */
const styledTemplate = (opts: StyledTemplateOpts, meta: Metadata): t.Node => {
  const nonceAttribute = meta.state.opts.nonce ? `nonce={${meta.state.opts.nonce}}` : '';
  const propsToDestructure: string[] = [];
  const styleProp = opts.variables.length
    ? styledStyleProp(opts.variables, (node) => {
        const nestedArrowFunctionExpressionVisitor = {
          noScope: true,
          MemberExpression(path: NodePath<t.MemberExpression>) {
            if (t.isIdentifier(path.node.object) && path.node.object.name === 'props') {
              const propertyAccessName = path.node.property as t.Identifier;
              if (isPropValid(propertyAccessName.name)) {
                return;
              }

              if (!propsToDestructure.includes(propertyAccessName.name)) {
                propsToDestructure.push(propertyAccessName.name);
              }

              path.replaceWith(propertyAccessName);
            }
          },
        };

        if (t.isArrowFunctionExpression(node)) {
          return traverseStyledArrowFunctionExpression(node, nestedArrowFunctionExpressionVisitor);
        }

        if (t.isBinaryExpression(node)) {
          return traverseStyledBinaryExpression(node, nestedArrowFunctionExpressionVisitor);
        }

        return node;
      })
    : t.identifier('style');

  return template(
    `
  React.forwardRef(({
    as: C = ${buildComponentTag(opts.tag)},
    style,
    ${propsToDestructure.map((prop) => prop + ',').join('')}
    ...props
  }, ref) => (
    <CC>
      <CS ${nonceAttribute}>{%%cssNode%%}</CS>
      <C
        {...props}
        style={%%styleProp%%}
        ref={ref}
        className={ax([${opts.classNames
          .map((className) => `"${className}"`)
          .join(',')}, props.className])}
      />
    </CC>
  ));
`,
    {
      plugins: ['jsx'],
    }
  )({
    styleProp,
    cssNode: t.arrayExpression(opts.sheets.map((sheet) => hoistSheet(sheet, meta))),
  }) as t.Node;
};

/**
 * Will return a generated AST for a Compiled Component.
 * This is primarily used for CSS prop and ClassNames apis.
 *
 * @param node Originating node
 * @param sheets Stylesheets
 * @param meta Metadata
 */
const compiledTemplate = (node: t.JSXElement, sheets: string[], meta: Metadata): t.Node => {
  const nonceAttribute = meta.state.opts.nonce ? `nonce={${meta.state.opts.nonce}}` : '';

  return template(
    `
  <CC>
    <CS ${nonceAttribute}>{%%cssNode%%}</CS>
    {%%jsxNode%%}
  </CC>
  `,
    {
      plugins: ['jsx'],
    }
  )({
    jsxNode: node,
    cssNode: t.arrayExpression(sheets.map((sheet) => hoistSheet(sheet, meta))),
  }) as t.Node;
};

/**
 * Will join two expressions together,
 * Looks like `left + ' ' + right`.
 *
 * @param left Any node on the left
 * @param right Any node on the right
 * @param spacer Optional spacer node to place between the left and right node. Defaults to a space string.
 */
export const joinExpressions = (
  left: any,
  right: any,
  spacer: any = t.stringLiteral(' ')
): t.BinaryExpression => {
  return t.binaryExpression('+', left, spacer ? t.binaryExpression('+', spacer, right) : right);
};

/**
 * Will conditionally join two expressions together depending on the right expression.
 * Looks like: `left + right ? ' ' + right : ''`
 */
export const conditionallyJoinExpressions = (left: any, right: any): t.BinaryExpression => {
  return t.binaryExpression(
    '+',
    left,
    t.conditionalExpression(
      right,
      t.binaryExpression('+', t.stringLiteral(' '), right),
      t.stringLiteral('')
    )
  );
};

/**
 * Returns a Styled Component AST.
 *
 * @param tag Styled tag either an inbuilt or user define
 * @param cssOutput CSS and variables to place onto the component
 * @param meta Plugin metadata
 */
export const buildStyledComponent = (tag: Tag, cssOutput: CSSOutput, meta: Metadata): t.Node => {
  const { classNames, sheets } = transformCss(cssOutput.css);

  return styledTemplate(
    {
      classNames,
      tag,
      sheets,
      variables: cssOutput.variables,
    },
    meta
  );
};

/**
 * Wrapper to make defining import specifiers easier.
 * If `localName` is defined it will rename the import to it,
 * e.g: `name as localName`.
 *
 * @param name import name
 * @param localName local name
 */
export const importSpecifier = (name: string, localName?: string) => {
  return t.importSpecifier(t.identifier(name), t.identifier(localName || name));
};

/**
 * Returns the actual value of a jsx value.
 *
 * @param node
 */
export const getPropValue = (
  node: t.JSXElement | t.JSXFragment | t.StringLiteral | t.JSXExpressionContainer
) => {
  const value = t.isJSXExpressionContainer(node) ? node.expression : node;

  if (t.isJSXEmptyExpression(value)) {
    throw new Error('Empty expression not supported.');
  }

  return value;
};

/**
 * Returns a Compiled Component AST.
 *
 * @param node Originating node
 * @param cssOutput CSS and variables to place onto the component
 * @param meta Plugin metadata
 */
export const buildCompiledComponent = (
  node: t.JSXElement,
  cssOutput: CSSOutput,
  meta: Metadata
): t.Node => {
  const { sheets, classNames } = transformCss(cssOutput.css);
  const classNameProp = node.openingElement.attributes.find((prop): prop is t.JSXAttribute => {
    return t.isJSXAttribute(prop) && prop.name.name === 'className';
  });

  if (classNameProp && classNameProp.value) {
    // If there is a class name prop statically defined we want to concatenate it with
    // the class name we're going to put on it.
    const classNameExpression = getPropValue(classNameProp.value);

    const values: t.Expression[] = classNames
      .map((className) => t.stringLiteral(className) as t.Expression)
      .concat(classNameExpression);

    classNameProp.value = t.jsxExpressionContainer(
      t.callExpression(t.identifier('ax'), [t.arrayExpression(values)])
    );
  } else {
    // No class name - just push our own one.
    node.openingElement.attributes.push(
      t.jsxAttribute(
        t.jsxIdentifier('className'),
        t.jsxExpressionContainer(
          t.callExpression(t.identifier('ax'), [
            t.arrayExpression(classNames.map((name) => t.stringLiteral(name))),
          ])
        )
      )
    );
  }

  if (cssOutput.variables.length) {
    // If there is dynamic CSS in use we have work to do.
    let stylePropIndex = -1;
    // Find the style prop on the opening JSX element.
    const styleProp = node.openingElement.attributes.find((prop, index): prop is t.JSXAttribute => {
      if (t.isJSXAttribute(prop) && prop.name.name === 'style') {
        stylePropIndex = index;
        return true;
      }

      return false;
    });

    const dynamicStyleProperties = buildCssVariablesProp(cssOutput.variables);

    if (styleProp) {
      // Remove the pre-existing style prop - we're going to redefine it soon.
      node.openingElement.attributes.splice(stylePropIndex, 1);

      if (
        styleProp.value &&
        t.isJSXExpressionContainer(styleProp.value) &&
        !t.isJSXEmptyExpression(styleProp.value.expression)
      ) {
        // If it's not an object we just spread the expression into the object
        if (!t.isObjectExpression(styleProp.value.expression)) {
          dynamicStyleProperties.splice(0, 0, t.spreadElement(styleProp.value.expression));
        } else {
          // Else it's an object! So we want to place each property into the object
          styleProp.value.expression.properties.forEach((prop, index) => {
            if (t.isObjectMethod(prop)) {
              return;
            }

            // We want to keep the order that they were defined in.
            // So we're using index here to do just that.
            dynamicStyleProperties.splice(index, 0, prop);
          });
        }
      }
    }

    // Finally add the new style prop back to the opening JSX element.
    node.openingElement.attributes.push(
      t.jsxAttribute(
        t.jsxIdentifier('style'),
        t.jsxExpressionContainer(t.objectExpression(dynamicStyleProperties))
      )
    );
  }

  return compiledTemplate(node, sheets, meta);
};
