/**
 * CloudFormation YAML loader — handles CFN intrinsic function shorthand tags
 * (!Sub, !Ref, !GetAtt, !FindInMap, !If, !Select, !Join, !Split, !Base64, etc.)
 */
import * as yaml from 'js-yaml';

function makeTags(tag, fnKey) {
  return [
    new yaml.Type(`!${tag}`, { kind: 'scalar',   construct: (d) => ({ [fnKey]: d }) }),
    new yaml.Type(`!${tag}`, { kind: 'sequence',  construct: (d) => ({ [fnKey]: d }) }),
    new yaml.Type(`!${tag}`, { kind: 'mapping',   construct: (d) => ({ [fnKey]: d }) }),
  ];
}

const cfnTags = [
  ...makeTags('Ref',        'Ref'),
  ...makeTags('Sub',        'Fn::Sub'),
  ...makeTags('GetAtt',     'Fn::GetAtt'),
  ...makeTags('FindInMap',  'Fn::FindInMap'),
  ...makeTags('If',         'Fn::If'),
  ...makeTags('Select',     'Fn::Select'),
  ...makeTags('Join',       'Fn::Join'),
  ...makeTags('Split',      'Fn::Split'),
  ...makeTags('Base64',     'Fn::Base64'),
  ...makeTags('ImportValue','Fn::ImportValue'),
  ...makeTags('Condition',  'Condition'),
  ...makeTags('And',        'Fn::And'),
  ...makeTags('Or',         'Fn::Or'),
  ...makeTags('Not',        'Fn::Not'),
  ...makeTags('Equals',     'Fn::Equals'),
  ...makeTags('Cidr',       'Fn::Cidr'),
];

const cfnSchema = yaml.DEFAULT_SCHEMA.extend(cfnTags);

export function loadCfnTemplate(content) {
  return yaml.load(content, { schema: cfnSchema });
}
