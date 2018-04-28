'use strict'

const moment = require('moment');
const rp = require('request-promise');
const cache = require('ez-cache')();
const express = require('express');
const path = require('path');
const _ = require('lodash');

const assets = path.join(__dirname, 'assets');
const app = express();
const port = 3000;

app.set('views', './views');
app.set('view engine', 'pug');
app.use('/assets', express.static(assets));

app.use((req, res, next) => {	
	res.locals = {
		confs: ['West', 'East', 'NBA Finals'],
		title: '2018 NBA Playoffs Bracket',
		allSeries: null,
		bracket: null,
		teams: {}
	};

	
	getBracket(req.query.hardRefresh)
		.then(bracketCacheEntry => {
			const bracket = bracketCacheEntry.data;
			const lastUpdated = new Date(bracketCacheEntry.created);

			res.locals.allSeries = bracket.series;
			res.locals.lastUpdated = {
				prettyString: moment(lastUpdated).fromNow(),
				date: lastUpdated.toString()
			};

			res.locals.bracket = {
				'one': _.filter(_.cloneDeep(bracket.series), ['roundNum', '1']),
				'two': _.filter(_.cloneDeep(bracket.series), ['roundNum', '2']),
				'three': _.filter(_.cloneDeep(bracket.series), ['roundNum', '3']),
				'finals': _.filter(_.cloneDeep(bracket.series), ['roundNum', '4']),
			};

			next();
		});
})

app.use((req, res, next) => {
	const seeds = _.merge(
		_.groupBy(res.locals.allSeries, 'topRow.teamId'),
		_.groupBy(res.locals.allSeries, 'bottomRow.teamId')
	);
	
	const promises = [];

	// grab team data
	_.keys(seeds).forEach(teamId => {
		let promise = getTeam(teamId)
			.then(team => {
				if (team === false) return;
				res.locals.teams[teamId] = team;
			})
			.catch(err => {
				console.log('err', err);
			});

		promises.push(promise);
	});

	Promise.all(promises)
		.then(() => {
			next();
		})
		.catch(err => {
			console.log('something went wrong.', err);
			res.status(500).send();
		});
});

app.get('/', (req, res) => {
	res.render('index', res.locals);
});

app.listen(port);

function getBracket(hardRefresh) {
	const url = 'http://data.nba.net/prod/v1/2017/playoffsBracket.json';
	const cacheFile = cache.getFilePath(url);
	const exists = cache.exists(cacheFile);

	if (!hardRefresh && exists) {
		return cache.get(cacheFile, true)
			.then(bracket => {
				return bracket;
			});
	}

	return rp.get(url, {json: true})
		.then(reply => {
			cache.set(cacheFile, reply);
			return {
				data: reply,
				created: Date.now()
			};
		});
}

function getTeam(id) {
	const url = `http://stats.nba.com/feeds/teams/profile/${id}_TeamProfile.js`;
	const cacheFile = cache.getFilePath(url);

	if (cache.exists(cacheFile)) {
		const team = cache.get(cacheFile);
		return cache.get(cacheFile)
			.then(team => {
				return team.TeamDetails[0].Details[0];
			});
	}

	return rp.get(url, {json: true})
		.then(reply => {
			if (!reply.TeamDetails || !reply.TeamDetails[0] || !reply.TeamDetails[0].Details) {
				return false;
			}

			cache.set(cacheFile, reply, true);
			return reply.TeamDetails[0].Details[0];
		});
}