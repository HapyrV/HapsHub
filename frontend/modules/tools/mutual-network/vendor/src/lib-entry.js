// The graph stack VRCX's Mutual Friends chart uses, exposed for HapsHub's plain scripts.
import Graph from 'graphology';
import Sigma from 'sigma';
import { createNodeCompoundProgram } from 'sigma/rendering';
import louvain from 'graphology-communities-louvain';
import EdgeCurveProgram from '@sigma/edge-curve';
import { createNodeBorderProgram } from '@sigma/node-border';
import { createNodeImageProgram } from '@sigma/node-image';
window.HHGraphLib = { Graph, Sigma, louvain, EdgeCurveProgram, createNodeBorderProgram, createNodeImageProgram, createNodeCompoundProgram };
